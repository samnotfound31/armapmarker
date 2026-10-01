import type { CameraFrameStamp } from "../session/CameraFrameTimeline";
import type { Mat3, TrackingQuality } from "../domain/types";

export type TrackingFrameContext = CameraFrameStamp & {nominalPlane: Mat3; nominalPoseRevision:number;roadRoiTopRatio?:number};

export type TrackingObservation = {
  timestampMs: number;
  candidateCount: number;
  inlierCount: number;
  medianReprojectionErrorPx: number;
  motionValid: boolean;
  observedHomography?: Mat3;
};

export type TrackingThresholds = {
  initialCandidateCount: number;
  initialInlierCount: number;
  weakInlierCount: number;
  weakInlierRatio: number;
  weakMedianReprojectionErrorPx: number;
  weakConsecutiveFrames: number;
  realignInlierCount: number;
  realignConsecutiveFrames: number;
  recoveryConsecutiveFrames: number;
  maxResultAgeMs: number;
  acquisitionFrames?: number;
  acquisitionSpanMs?: number;
  weakAfterMs?: number;
  realignAfterMs?: number;
};

export type TrackingUpdateOutcome = {
  accepted: boolean;
  reason: "accepted" | "stale" | "rejected";
  quality: TrackingQuality;
};

export type TrackerResult = {
  status: "initializing" | "tracked" | "lost";
  timestampMs: number;
  keyframeId: number;
  visualHomography: Mat3 | null;
  quality: TrackingQuality;
  context?: TrackingFrameContext;
  referenceTimestampMs?: number;
  promoteCandidate?: boolean;
  originalFeatureCount?:number;
  spatialCoverage?:number;
  p90ReprojectionErrorPx?:number;
  symmetricTransferErrorPx?:number;
  sharpness?:number;
  processingMs?:number;
};

export type TrackerWorkerRequest =
  | { type: "initialize" }
  | {
      type: "frame";
      frame: ImageBitmap;
      timestampMs: number;
      sensorHomography: Mat3;
      context?: TrackingFrameContext;
    }
  | { type: "commit"; timestampMs: number; accepted: boolean; promote: boolean }
  | { type: "dispose" };

export type TrackerWorkerResponse =
  | { type: "ready" }
  | { type: "result"; result: TrackerResult }
  | { type: "unavailable"; message: string };
