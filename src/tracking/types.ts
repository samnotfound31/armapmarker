import type { Mat3, TrackingQuality } from "../domain/types";

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
};

export type TrackingUpdateOutcome = {
  accepted: boolean;
  reason: "accepted" | "stale";
  quality: TrackingQuality;
};

export type TrackerResult = {
  status: "initializing" | "tracked" | "lost";
  timestampMs: number;
  keyframeId: number;
  visualHomography: Mat3 | null;
  quality: TrackingQuality;
};

export type TrackerWorkerRequest =
  | { type: "initialize" }
  | {
      type: "frame";
      frame: ImageBitmap;
      timestampMs: number;
      sensorHomography: Mat3;
    }
  | { type: "dispose" };

export type TrackerWorkerResponse =
  | { type: "ready" }
  | { type: "result"; result: TrackerResult }
  | { type: "unavailable"; message: string };
