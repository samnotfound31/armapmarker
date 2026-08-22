import type { Mat3, TrackingQuality } from "../domain/types";
import type { CV, Mat } from "@techstark/opencv-js";
import { TrackingQualityGate } from "./quality";
import {
  computeResidualHomography,
  invertHomography,
  multiplyHomographies,
  normalizeHomography,
  limitVisualResidual
} from "./residualHomography";
import type { TrackerResult } from "./types";

export type CvAllocation = {
  delete(): void;
};

export type PreparedCvFrame = {
  resources: readonly CvAllocation[];
  candidateCount: number;
  trackingFromImage: Mat3;
  opaque: unknown;
};

export type CvTrackEstimate = {
  resources: readonly CvAllocation[];
  homography: Mat3 | null;
  trackedFeatureCount: number;
  inlierCount: number;
  medianReprojectionErrorPx: number;
  motionValid: boolean;
};

export type OpenCvAdapter = {
  prepareFrame(frame: ImageBitmap | ImageData): PreparedCvFrame | Promise<PreparedCvFrame>;
  track(
    previousFrame: PreparedCvFrame,
    currentFrame: PreparedCvFrame
  ): CvTrackEstimate | Promise<CvTrackEstimate>;
};

type OpenCvFrameOpaque = {
  grayRoadRoi: Mat;
  features: Mat;
};

const OPENCV_CONFIG = {
  maxFrameWidthPx: 480,
  roadRoiTopRatio: 0.38,
  maxFeatures: 120,
  featureQuality: 0.01,
  minimumFeatureDistancePx: 8,
  forwardBackwardErrorPx: 1.5,
  ransacReprojectionThresholdPx: 3
} as const;

const IDENTITY_HOMOGRAPHY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export type OpenCvTrackerConfig = {
  keyframeReplacementIntervalFrames: number;
};

const DEFAULT_TRACKER_CONFIG: Readonly<OpenCvTrackerConfig> = {
  keyframeReplacementIntervalFrames: 30
};

export class OpenCvTracker {
  private previousFrame: PreparedCvFrame | null = null;
  private readonly qualityGate = new TrackingQualityGate();
  private keyframeId = 1;
  private framesSinceKeyframe = 0;
  private keyframeBaseHomography: Mat3 = IDENTITY_HOMOGRAPHY;
  private residualSinceKeyframe: Mat3 = IDENTITY_HOMOGRAPHY;
  private disposed = false;

  constructor(
    private readonly adapter: OpenCvAdapter,
    private readonly config: Readonly<OpenCvTrackerConfig> =
      DEFAULT_TRACKER_CONFIG
  ) {
    if (config.keyframeReplacementIntervalFrames < 1) {
      throw new RangeError("Keyframe replacement interval must be positive.");
    }
  }

  async process(
    frame: ImageBitmap | ImageData,
    timestampMs: number,
    sensorHomography: Mat3 = IDENTITY_HOMOGRAPHY
  ): Promise<TrackerResult> {
    if (this.disposed) throw new Error("OpenCV tracker is disposed.");

    const currentFrame = await this.adapter.prepareFrame(frame);
    const previousFrame = this.previousFrame;
    if (!previousFrame) {
      this.previousFrame = currentFrame;
      return {
        status: "initializing",
        timestampMs,
        keyframeId: this.keyframeId,
        visualHomography: null,
        quality: initializingQuality(currentFrame.candidateCount)
      };
    }

    let estimate: CvTrackEstimate | null = null;
    try {
      estimate = await this.adapter.track(previousFrame, currentFrame);
      const observedHomography = estimate.homography
        ? toFullImageHomography(
            estimate.homography,
            previousFrame.trackingFromImage,
            currentFrame.trackingFromImage
          )
        : undefined;
      const outcome = this.qualityGate.update({
        timestampMs,
        candidateCount: estimate.trackedFeatureCount,
        inlierCount: estimate.inlierCount,
        medianReprojectionErrorPx: estimate.medianReprojectionErrorPx,
        motionValid: estimate.motionValid && estimate.homography !== null,
        ...(observedHomography ? { observedHomography } : {})
      });
      if (!observedHomography || !estimate.motionValid) {
        this.previousFrame = currentFrame;
        deleteAllocations(previousFrame.resources);
        return {
          status: "lost",
          timestampMs,
          keyframeId: this.keyframeId,
          visualHomography: null,
          quality: outcome.quality
        };
      }

      const frameVisualHomography = computeResidualHomography(
        observedHomography,
        sensorHomography
      );
      this.residualSinceKeyframe = normalizeHomography(
        multiplyHomographies(
          frameVisualHomography,
          this.residualSinceKeyframe
        )
      );
      const accumulatedVisualHomography = limitVisualResidual(
        normalizeHomography(
          multiplyHomographies(
            this.residualSinceKeyframe,
            this.keyframeBaseHomography
          )
        )
      );
      if (outcome.quality.state === "locked") {
        this.framesSinceKeyframe += 1;
        if (
          this.framesSinceKeyframe >=
            this.config.keyframeReplacementIntervalFrames
        ) {
          this.keyframeBaseHomography = accumulatedVisualHomography;
          this.residualSinceKeyframe = IDENTITY_HOMOGRAPHY;
          this.keyframeId += 1;
          this.framesSinceKeyframe = 0;
        }
      }
      this.previousFrame = currentFrame;
      deleteAllocations(previousFrame.resources);
      return {
        status: "tracked",
        timestampMs,
        keyframeId: this.keyframeId,
        visualHomography: accumulatedVisualHomography,
        quality: outcome.quality
      };
    } catch (error) {
      this.previousFrame = null;
      deleteAllocations(previousFrame.resources);
      deleteAllocations(currentFrame.resources);
      throw error;
    } finally {
      if (estimate) deleteAllocations(estimate.resources);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.previousFrame) {
      deleteAllocations(this.previousFrame.resources);
      this.previousFrame = null;
    }
  }
}

export async function loadOpenCvTracker(): Promise<OpenCvTracker> {
  const cv = await loadOpenCv();
  return new OpenCvTracker(new OpenCvJsAdapter(cv));
}

class OpenCvJsAdapter implements OpenCvAdapter {
  constructor(private readonly cv: CV) {}

  prepareFrame(frame: ImageBitmap | ImageData): PreparedCvFrame {
    const allocations: Mat[] = [];
    try {
      const imageData = readImageData(frame);
      const rgba = this.cv.matFromImageData(imageData);
      const grayscale = new this.cv.Mat();
      const resized = new this.cv.Mat();
      allocations.push(rgba, grayscale, resized);
      this.cv.cvtColor(rgba, grayscale, this.cv.COLOR_RGBA2GRAY);

      const scale = Math.min(1, OPENCV_CONFIG.maxFrameWidthPx / grayscale.cols);
      const width = Math.max(1, Math.round(grayscale.cols * scale));
      const height = Math.max(1, Math.round(grayscale.rows * scale));
      this.cv.resize(
        grayscale,
        resized,
        new this.cv.Size(width, height),
        0,
        0,
        this.cv.INTER_AREA
      );

      const roiTop = Math.min(
        height - 1,
        Math.max(0, Math.floor(height * OPENCV_CONFIG.roadRoiTopRatio))
      );
      const roiHeader = resized.roi(new this.cv.Rect(0, roiTop, width, height - roiTop));
      const grayRoadRoi = roiHeader.clone();
      const features = new this.cv.Mat();
      allocations.push(roiHeader, grayRoadRoi, features);
      this.cv.goodFeaturesToTrack(
        grayRoadRoi,
        features,
        OPENCV_CONFIG.maxFeatures,
        OPENCV_CONFIG.featureQuality,
        OPENCV_CONFIG.minimumFeatureDistancePx
      );

      deleteAllocations([rgba, grayscale, resized, roiHeader]);
      return {
        resources: [grayRoadRoi, features],
        candidateCount: features.rows,
        trackingFromImage: [
          scale, 0, 0,
          0, scale, 0,
          0, -roiTop, 1
        ],
        opaque: { grayRoadRoi, features } satisfies OpenCvFrameOpaque
      };
    } catch (error) {
      deleteAllocations(allocations);
      throw error;
    }
  }

  track(
    previousFrame: PreparedCvFrame,
    currentFrame: PreparedCvFrame
  ): CvTrackEstimate {
    const previous = assertOpenCvFrame(previousFrame.opaque);
    const current = assertOpenCvFrame(currentFrame.opaque);
    const resources: Mat[] = [];
    try {
      const nextPoints = new this.cv.Mat();
      const forwardStatus = new this.cv.Mat();
      const forwardErrors = new this.cv.Mat();
      const backwardPoints = new this.cv.Mat();
      const backwardStatus = new this.cv.Mat();
      const backwardErrors = new this.cv.Mat();
      resources.push(
        nextPoints,
        forwardStatus,
        forwardErrors,
        backwardPoints,
        backwardStatus,
        backwardErrors
      );
      this.cv.calcOpticalFlowPyrLK(
        previous.grayRoadRoi,
        current.grayRoadRoi,
        previous.features,
        nextPoints,
        forwardStatus,
        forwardErrors
      );
      this.cv.calcOpticalFlowPyrLK(
        current.grayRoadRoi,
        previous.grayRoadRoi,
        nextPoints,
        backwardPoints,
        backwardStatus,
        backwardErrors
      );

      const matches = collectForwardBackwardMatches(
        previous.features.data32F,
        nextPoints.data32F,
        backwardPoints.data32F,
        forwardStatus.data8U,
        backwardStatus.data8U,
        OPENCV_CONFIG.forwardBackwardErrorPx
      );
      if (matches.count < 4) {
        return lostEstimate(resources, matches.count);
      }

      const sourcePoints = this.cv.matFromArray(
        matches.count,
        1,
        this.cv.CV_32FC2,
        matches.source
      );
      const destinationPoints = this.cv.matFromArray(
        matches.count,
        1,
        this.cv.CV_32FC2,
        matches.destination
      );
      const inlierMask = new this.cv.Mat();
      resources.push(sourcePoints, destinationPoints, inlierMask);
      const homographyMat = this.cv.findHomography(
        sourcePoints,
        destinationPoints,
        this.cv.RANSAC,
        OPENCV_CONFIG.ransacReprojectionThresholdPx,
        inlierMask
      );
      resources.push(homographyMat);
      if (homographyMat.empty()) {
        return lostEstimate(resources, matches.count);
      }

      const homography = openCvHomographyToColumnMajor(homographyMat);
      const reprojectionErrors = calculateReprojectionErrors(
        matches.source,
        matches.destination,
        inlierMask.data8U,
        homography
      );
      const inlierCount = reprojectionErrors.length;
      return {
        resources,
        homography,
        trackedFeatureCount: matches.count,
        inlierCount,
        medianReprojectionErrorPx: median(reprojectionErrors),
        motionValid: isPlausibleMotion(
          homography,
          current.grayRoadRoi.cols,
          current.grayRoadRoi.rows
        )
      };
    } catch (error) {
      deleteAllocations(resources);
      throw error;
    }
  }
}

export function toFullImageHomography(
  trackingHomography: Mat3,
  previousTrackingFromImage: Mat3,
  currentTrackingFromImage: Mat3
): Mat3 {
  return normalizeHomography(
    multiplyHomographies(
      invertHomography(currentTrackingFromImage),
      multiplyHomographies(trackingHomography, previousTrackingFromImage)
    )
  );
}

async function loadOpenCv(): Promise<CV> {
  const imported = await import("@techstark/opencv-js");
  const moduleValue = (imported as unknown as { default?: unknown }).default ?? imported;
  const candidate = await Promise.resolve(moduleValue as CV | Promise<CV>);
  if (candidate.Mat) return candidate;

  await new Promise<void>((resolve, reject) => {
    const runtime = candidate as CV & { onRuntimeInitialized?: () => void };
    const timeout = globalThis.setTimeout(
      () => reject(new Error("OpenCV initialization timed out.")),
      15_000
    );
    runtime.onRuntimeInitialized = () => {
      globalThis.clearTimeout(timeout);
      resolve();
    };
  });
  if (!candidate.Mat) throw new Error("OpenCV runtime is unavailable.");
  return candidate;
}

function readImageData(frame: ImageBitmap | ImageData): ImageData {
  if (typeof ImageData !== "undefined" && frame instanceof ImageData) return frame;
  const bitmap = frame as ImageBitmap;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("A 2D canvas is required for visual tracking.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("A 2D canvas is required for visual tracking.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  throw new Error("Canvas frame extraction is unavailable in this browser.");
}

function assertOpenCvFrame(value: unknown): OpenCvFrameOpaque {
  if (!value || typeof value !== "object") {
    throw new TypeError("OpenCV frame state is invalid.");
  }
  return value as OpenCvFrameOpaque;
}

function collectForwardBackwardMatches(
  previousPoints: Float32Array,
  nextPoints: Float32Array,
  backwardPoints: Float32Array,
  forwardStatus: Uint8Array,
  backwardStatus: Uint8Array,
  maximumErrorPx: number
): { source: number[]; destination: number[]; count: number } {
  const source: number[] = [];
  const destination: number[] = [];
  const pointCount = Math.min(
    forwardStatus.length,
    backwardStatus.length,
    Math.floor(previousPoints.length / 2),
    Math.floor(nextPoints.length / 2),
    Math.floor(backwardPoints.length / 2)
  );
  for (let index = 0; index < pointCount; index += 1) {
    if (!forwardStatus[index] || !backwardStatus[index]) continue;
    const offset = index * 2;
    const previousX = previousPoints[offset]!;
    const previousY = previousPoints[offset + 1]!;
    const nextX = nextPoints[offset]!;
    const nextY = nextPoints[offset + 1]!;
    const backwardX = backwardPoints[offset]!;
    const backwardY = backwardPoints[offset + 1]!;
    const values = [previousX, previousY, nextX, nextY, backwardX, backwardY];
    if (values.some((value) => !Number.isFinite(value))) continue;
    if (Math.hypot(backwardX - previousX, backwardY - previousY) > maximumErrorPx) {
      continue;
    }
    source.push(previousX, previousY);
    destination.push(nextX, nextY);
  }
  return { source, destination, count: source.length / 2 };
}

function openCvHomographyToColumnMajor(matrix: Mat): Mat3 {
  const data = matrix.data64F.length >= 9 ? matrix.data64F : matrix.data32F;
  if (data.length < 9) throw new RangeError("OpenCV returned an invalid homography.");
  return [
    data[0]!, data[3]!, data[6]!,
    data[1]!, data[4]!, data[7]!,
    data[2]!, data[5]!, data[8]!
  ];
}

function calculateReprojectionErrors(
  source: readonly number[],
  destination: readonly number[],
  mask: Uint8Array,
  homography: Mat3
): number[] {
  const errors: number[] = [];
  for (let index = 0; index < source.length / 2; index += 1) {
    if (!mask[index]) continue;
    const offset = index * 2;
    const x = source[offset]!;
    const y = source[offset + 1]!;
    const divisor = homography[2] * x + homography[5] * y + homography[8];
    if (Math.abs(divisor) < 1e-9) continue;
    const projectedX =
      (homography[0] * x + homography[3] * y + homography[6]) / divisor;
    const projectedY =
      (homography[1] * x + homography[4] * y + homography[7]) / divisor;
    errors.push(
      Math.hypot(
        projectedX - destination[offset]!,
        projectedY - destination[offset + 1]!
      )
    );
  }
  return errors;
}

function isPlausibleMotion(matrix: Mat3, width: number, height: number): boolean {
  if (matrix.some((value) => !Number.isFinite(value))) return false;
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[7] * matrix[5]) -
    matrix[3] * (matrix[1] * matrix[8] - matrix[7] * matrix[2]) +
    matrix[6] * (matrix[1] * matrix[5] - matrix[4] * matrix[2]);
  const displacement = Math.hypot(matrix[6], matrix[7]);
  return (
    Math.abs(determinant) > 1e-8 &&
    Math.abs(matrix[2]) < 0.02 &&
    Math.abs(matrix[5]) < 0.02 &&
    displacement <= Math.max(width, height) * 0.75
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function lostEstimate(
  resources: readonly CvAllocation[],
  trackedFeatureCount: number
): CvTrackEstimate {
  return {
    resources,
    homography: null,
    trackedFeatureCount,
    inlierCount: 0,
    medianReprojectionErrorPx: Number.POSITIVE_INFINITY,
    motionValid: false
  };
}

function initializingQuality(featureCount: number): TrackingQuality {
  return {
    state: "weak",
    featureCount,
    inlierCount: 0,
    inlierRatio: 0,
    medianReprojectionErrorPx: Number.POSITIVE_INFINITY
  };
}

function deleteAllocations(allocations: readonly CvAllocation[]): void {
  const uniqueAllocations = new Set(allocations);
  for (const allocation of uniqueAllocations) allocation.delete();
}
