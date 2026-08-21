import type {
  CalibrationStage,
  CameraIntrinsics,
  GroundCalibration,
  Mat3,
  Mat4
} from "../domain/types";
import {
  averageOrientationSamples,
  type OrientationCalibrationSample
} from "../geometry/groundCalibration";
import { CALIBRATION_CONFIG, type Vec3 } from "../geometry/intrinsics";

export type ScanObservation = {
  featureCount: number;
  inlierCount: number;
  angularMotionRad: number;
};

export type CalibrationState = {
  stage: CalibrationStage;
  cameraHeightMeters: 1.2 | 1.4 | 1.6;
  validScanSamples: number;
  totalScanSamples: number;
  retryReason?: string;
  orientation?: OrientationCalibrationSample;
  cameraFromGroundAtLock?: Mat4;
  earthFromGroundAtLock?: Mat3;
  nearGround?: Vec3;
  farGround?: Vec3;
  lockedCalibration?: GroundCalibration;
};

export type CalibrationEvent =
  | {
      type: "SELECT_HEIGHT";
      cameraHeightMeters: 1.2 | 1.4 | 1.6;
    }
  | {
      type: "CAPTURE_ORIENTATION";
      samples: readonly OrientationCalibrationSample[];
      cameraFromGroundAtLock: Mat4;
      earthFromGroundAtLock?: Mat3;
    }
  | { type: "TAP_GROUND"; point: Vec3 }
  | { type: "SCAN_OBSERVATION"; observation: ScanObservation }
  | {
      type: "LOCK";
      intrinsics: CameraIntrinsics;
      imageToScreen: Mat3;
      groundFromRoute: Mat4;
      calibrationRouteDistanceMeters: number;
      lockedAtMs: number;
    }
  | { type: "REALIGN" };

export function createCalibrationState(): CalibrationState {
  return {
    stage: "select-height",
    cameraHeightMeters: 1.4,
    validScanSamples: 0,
    totalScanSamples: 0
  };
}

export function calibrationReducer(
  state: CalibrationState,
  event: CalibrationEvent
): CalibrationState {
  if (event.type === "REALIGN") return createCalibrationState();
  if (state.stage === "locked") return state;

  switch (event.type) {
    case "SELECT_HEIGHT":
      return {
        ...createCalibrationState(),
        stage: "capture-orientation",
        cameraHeightMeters: event.cameraHeightMeters
      };
    case "CAPTURE_ORIENTATION":
      if (state.stage !== "capture-orientation") {
        return reject(state, "Select a camera height before orientation capture.");
      }
      if (
        event.samples.length <
        CALIBRATION_CONFIG.minimumStableOrientationSamples
      ) {
        return reject(state, "Hold still until orientation capture completes.");
      }
      return {
        ...state,
        stage: "tap-near",
        orientation: averageOrientationSamples(event.samples),
        cameraFromGroundAtLock: event.cameraFromGroundAtLock,
        ...(event.earthFromGroundAtLock
          ? { earthFromGroundAtLock: event.earthFromGroundAtLock }
          : {}),
        retryReason: undefined
      };
    case "TAP_GROUND":
      if (state.stage === "tap-near") {
        return {
          ...state,
          stage: "tap-far",
          nearGround: event.point,
          retryReason: undefined
        };
      }
      if (state.stage === "tap-far" && state.nearGround) {
        const separation = Math.hypot(
          event.point[0] - state.nearGround[0],
          event.point[2] - state.nearGround[2]
        );
        if (separation < CALIBRATION_CONFIG.minimumTapSeparationMeters) {
          return reject(
            state,
            "Tap a far point at least two metres beyond the near point."
          );
        }
        return {
          ...state,
          stage: "scan-features",
          farGround: event.point,
          validScanSamples: 0,
          totalScanSamples: 0,
          retryReason: undefined
        };
      }
      return reject(state, "Select a height and capture orientation before tapping the road.");
    case "SCAN_OBSERVATION": {
      if (state.stage !== "scan-features") return state;
      const totalScanSamples = state.totalScanSamples + 1;
      if (
        event.observation.angularMotionRad >
        CALIBRATION_CONFIG.maximumScanAngularMotionRad
      ) {
        return {
          ...state,
          validScanSamples: 0,
          totalScanSamples,
          retryReason: "Move the phone more slowly and keep your body steadier."
        };
      }
      if (
        event.observation.featureCount < CALIBRATION_CONFIG.initialFeatureCount ||
        event.observation.inlierCount < CALIBRATION_CONFIG.initialInlierCount
      ) {
        return {
          ...state,
          validScanSamples: 0,
          totalScanSamples,
          retryReason: "Aim at a more textured patch of road and scan again."
        };
      }
      const validScanSamples = state.validScanSamples + 1;
      return {
        ...state,
        stage:
          validScanSamples >= CALIBRATION_CONFIG.minimumStableScanSamples
            ? "ready"
            : "scan-features",
        validScanSamples,
        totalScanSamples,
        retryReason: undefined
      };
    }
    case "LOCK": {
      if (state.stage !== "ready" || !state.cameraFromGroundAtLock) return state;
      const lockedCalibration: GroundCalibration = {
        stage: "locked",
        cameraHeightMeters: state.cameraHeightMeters,
        intrinsics: event.intrinsics,
        imageToScreen: event.imageToScreen,
        groundFromRoute: event.groundFromRoute,
        cameraFromGroundAtLock: state.cameraFromGroundAtLock,
        ...(state.earthFromGroundAtLock
          ? { earthFromGroundAtLock: state.earthFromGroundAtLock }
          : {}),
        calibrationRouteDistanceMeters: event.calibrationRouteDistanceMeters,
        lockedAtMs: event.lockedAtMs
      };
      return { ...state, stage: "locked", lockedCalibration };
    }
  }
}

function reject(state: CalibrationState, retryReason: string): CalibrationState {
  return { ...state, retryReason };
}
