import type {
  GroundCalibration,
  Mat3,
  Mat4,
  PoseEstimate,
  TrackingQuality,
  VisualCorrection
} from "../domain/types";
import { limitVisualResidual } from "../tracking/residualHomography";

const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const EMPTY_QUALITY: TrackingQuality = {
  state: "weak",
  featureCount: 0,
  inlierCount: 0,
  inlierRatio: 0,
  medianReprojectionErrorPx: Number.POSITIVE_INFINITY
};

export type GpsPoseUpdate = {
  timestampMs: number;
  routeProgressMeters: number;
  cameraPositionGroundMeters: [number, number, number];
};

export type SensorPoseUpdate = {
  timestampMs: number;
  cameraFromGround: Mat4;
  orientationQuaternion: [number, number, number, number];
};

export type VisualPoseUpdate = VisualCorrection & {
  quality: TrackingQuality;
};

export type PoseFusionConfig = {
  maxFreshVisualAgeMs: number;
  visualFadeDurationMs: number;
  weakVisualWeight: number;
  maxVisualDisplacementPx: number;
  maxVisualConditionNumber: number;
};

const DEFAULT_CONFIG: Readonly<PoseFusionConfig> = {
  maxFreshVisualAgeMs: 250,
  visualFadeDurationMs: 500,
  weakVisualWeight: 0.45,
  maxVisualDisplacementPx: 80,
  maxVisualConditionNumber: 20
};

export class PoseFusion {
  private routeProgressMeters: number;
  private cameraPositionGroundMeters: [number, number, number];
  private cameraFromGround: Mat4;
  private orientationQuaternion: [number, number, number, number] = [0, 0, 0, 1];
  private visual: VisualPoseUpdate | null = null;
  private lastGpsTimestampMs = Number.NEGATIVE_INFINITY;
  private lastSensorTimestampMs = Number.NEGATIVE_INFINITY;
  private lastVisualTimestampMs = Number.NEGATIVE_INFINITY;
  private readonly imageWidthPx: number;
  private readonly imageHeightPx: number;

  constructor(
    calibration: GroundCalibration,
    private readonly config: Readonly<PoseFusionConfig> = DEFAULT_CONFIG
  ) {
    this.routeProgressMeters = calibration.calibrationRouteDistanceMeters;
    this.cameraPositionGroundMeters = [0, calibration.cameraHeightMeters, 0];
    this.cameraFromGround = calibration.cameraFromGroundAtLock;
    this.imageWidthPx = calibration.intrinsics.imageWidthPx;
    this.imageHeightPx = calibration.intrinsics.imageHeightPx;
  }

  updateGps(update: GpsPoseUpdate): boolean {
    if (update.timestampMs <= this.lastGpsTimestampMs) return false;
    this.lastGpsTimestampMs = update.timestampMs;
    this.routeProgressMeters = Math.max(0, update.routeProgressMeters);
    this.cameraPositionGroundMeters = [...update.cameraPositionGroundMeters];
    this.cameraFromGround = withCameraPosition(
      this.cameraFromGround,
      this.cameraPositionGroundMeters
    );
    return true;
  }

  updateSensor(update: SensorPoseUpdate): boolean {
    if (update.timestampMs <= this.lastSensorTimestampMs) return false;
    this.lastSensorTimestampMs = update.timestampMs;
    this.cameraFromGround = withCameraPosition(
      update.cameraFromGround,
      this.cameraPositionGroundMeters
    );
    this.orientationQuaternion = normalizeQuaternion(update.orientationQuaternion);
    return true;
  }

  updateVisual(update: VisualPoseUpdate): boolean {
    if (update.timestampMs <= this.lastVisualTimestampMs) return false;
    this.lastVisualTimestampMs = update.timestampMs;
    this.visual = {
      ...update,
      imageHomography: limitVisualResidual(update.imageHomography, {
        imageWidthPx: this.imageWidthPx,
        imageHeightPx: this.imageHeightPx,
        maxPointDisplacementPx: this.config.maxVisualDisplacementPx,
        maxConditionNumber: this.config.maxVisualConditionNumber
      })
    };
    return true;
  }

  snapshot(nowMs = this.latestTimestamp()): PoseEstimate {
    const visualCorrection = this.visualCorrectionAt(nowMs);
    return {
      cameraPositionGroundMeters: [...this.cameraPositionGroundMeters],
      orientationQuaternion: [...this.orientationQuaternion],
      cameraFromGround: this.cameraFromGround,
      visualCorrection,
      routeProgressMeters: this.routeProgressMeters,
      quality: this.visual?.quality ?? EMPTY_QUALITY,
      timestampMs: nowMs
    };
  }

  private visualCorrectionAt(nowMs: number): VisualCorrection {
    if (!this.visual) {
      return { imageHomography: IDENTITY_MAT3, keyframeId: 0, timestampMs: nowMs };
    }
    const ageMs = Math.max(0, nowMs - this.visual.timestampMs);
    const ageWeight =
      ageMs <= this.config.maxFreshVisualAgeMs
        ? 1
        : clamp(
            1 -
              (ageMs - this.config.maxFreshVisualAgeMs) /
                this.config.visualFadeDurationMs,
            0,
            1
          );
    const qualityWeight =
      this.visual.quality.state === "locked"
        ? 1
        : this.visual.quality.state === "weak"
          ? this.config.weakVisualWeight
          : 0;
    return {
      imageHomography: scaleProjectiveCorrection(
        this.visual.imageHomography,
        ageWeight * qualityWeight
      ),
      keyframeId: this.visual.keyframeId,
      timestampMs: this.visual.timestampMs
    };
  }

  private latestTimestamp(): number {
    const latest = Math.max(
      this.lastGpsTimestampMs,
      this.lastSensorTimestampMs,
      this.lastVisualTimestampMs
    );
    return Number.isFinite(latest) ? latest : 0;
  }
}

function scaleProjectiveCorrection(matrix: Mat3, weight: number): Mat3 {
  if (weight <= 0) return IDENTITY_MAT3;
  if (weight >= 1) return matrix;
  return [
    1 + (matrix[0] - 1) * weight,
    matrix[1] * weight,
    matrix[2] * weight,
    matrix[3] * weight,
    1 + (matrix[4] - 1) * weight,
    matrix[5] * weight,
    matrix[6] * weight,
    matrix[7] * weight,
    1
  ];
}

function normalizeQuaternion(
  quaternion: [number, number, number, number]
): [number, number, number, number] {
  const length = Math.hypot(...quaternion);
  if (!Number.isFinite(length) || length <= 1e-9) return [0, 0, 0, 1];
  return quaternion.map((component) => component / length) as [
    number,
    number,
    number,
    number
  ];
}

function withCameraPosition(
  cameraFromGround: Mat4,
  cameraPositionGround: [number, number, number]
): Mat4 {
  const [x, y, z] = cameraPositionGround;
  return [
    cameraFromGround[0], cameraFromGround[1], cameraFromGround[2], 0,
    cameraFromGround[4], cameraFromGround[5], cameraFromGround[6], 0,
    cameraFromGround[8], cameraFromGround[9], cameraFromGround[10], 0,
    -(cameraFromGround[0] * x + cameraFromGround[4] * y + cameraFromGround[8] * z),
    -(cameraFromGround[1] * x + cameraFromGround[5] * y + cameraFromGround[9] * z),
    -(cameraFromGround[2] * x + cameraFromGround[6] * y + cameraFromGround[10] * z),
    1
  ];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
