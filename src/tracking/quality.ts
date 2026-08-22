import type { Mat3, TrackingQuality, TrackingState } from "../domain/types";
import type {
  TrackingObservation,
  TrackingThresholds,
  TrackingUpdateOutcome
} from "./types";

export const DEFAULT_TRACKING_THRESHOLDS: Readonly<TrackingThresholds> = {
  initialCandidateCount: 30,
  initialInlierCount: 15,
  weakInlierCount: 15,
  weakInlierRatio: 0.55,
  weakMedianReprojectionErrorPx: 3,
  weakConsecutiveFrames: 5,
  realignInlierCount: 10,
  realignConsecutiveFrames: 10,
  recoveryConsecutiveFrames: 3,
  maxResultAgeMs: 250
};

const EMPTY_QUALITY: TrackingQuality = {
  state: "weak",
  featureCount: 0,
  inlierCount: 0,
  inlierRatio: 0,
  medianReprojectionErrorPx: Number.POSITIVE_INFINITY
};

export class TrackingQualityGate {
  private currentState: TrackingState = "weak";
  private quality: TrackingQuality = EMPTY_QUALITY;
  private poorFrames = 0;
  private criticalFrames = 0;
  private recoveryFrames = 0;
  private hasLocked = false;
  private latestHomography: { matrix: Mat3; timestampMs: number } | null = null;

  constructor(
    private readonly thresholds: Readonly<TrackingThresholds> =
      DEFAULT_TRACKING_THRESHOLDS
  ) {}

  get state(): TrackingState {
    return this.currentState;
  }

  snapshot(): TrackingQuality {
    return { ...this.quality };
  }

  update(
    observation: TrackingObservation,
    receivedAtMs = observation.timestampMs
  ): TrackingUpdateOutcome {
    const ageMs = receivedAtMs - observation.timestampMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.thresholds.maxResultAgeMs) {
      return { accepted: false, reason: "stale", quality: this.snapshot() };
    }

    const candidateCount = nonNegativeInteger(observation.candidateCount);
    const inlierCount = Math.min(
      candidateCount,
      nonNegativeInteger(observation.inlierCount)
    );
    const inlierRatio = candidateCount === 0 ? 0 : inlierCount / candidateCount;
    const reprojectionError = Number.isFinite(observation.medianReprojectionErrorPx)
      ? Math.max(0, observation.medianReprojectionErrorPx)
      : Number.POSITIVE_INFINITY;
    const acquisitionReady =
      observation.motionValid &&
      candidateCount >= this.thresholds.initialCandidateCount &&
      inlierCount >= this.thresholds.initialInlierCount &&
      reprojectionError <= this.thresholds.weakMedianReprojectionErrorPx;
    const stable =
      acquisitionReady && inlierRatio >= this.thresholds.weakInlierRatio;
    const poor =
      !observation.motionValid ||
      inlierCount < this.thresholds.weakInlierCount ||
      inlierRatio < this.thresholds.weakInlierRatio ||
      reprojectionError > this.thresholds.weakMedianReprojectionErrorPx;
    const critical =
      !observation.motionValid || inlierCount < this.thresholds.realignInlierCount;

    this.poorFrames = poor ? this.poorFrames + 1 : 0;
    this.criticalFrames = critical ? this.criticalFrames + 1 : 0;

    if (!this.hasLocked) {
      if (acquisitionReady) {
        this.hasLocked = true;
        this.currentState = "locked";
      }
    } else if (this.currentState === "realign") {
      this.recoveryFrames = 0;
    } else if (
      this.criticalFrames >= this.thresholds.realignConsecutiveFrames
    ) {
      this.currentState = "realign";
      this.recoveryFrames = 0;
    } else if (
      this.currentState === "locked" &&
      this.poorFrames >= this.thresholds.weakConsecutiveFrames
    ) {
      this.currentState = "weak";
      this.recoveryFrames = 0;
    } else if (this.currentState !== "locked") {
      this.recoveryFrames = stable ? this.recoveryFrames + 1 : 0;
      if (this.recoveryFrames >= this.thresholds.recoveryConsecutiveFrames) {
        this.currentState = "locked";
        this.poorFrames = 0;
        this.criticalFrames = 0;
        this.recoveryFrames = 0;
      }
    }

    this.quality = {
      state: this.currentState,
      featureCount: candidateCount,
      inlierCount,
      inlierRatio,
      medianReprojectionErrorPx: reprojectionError
    };
    if (observation.observedHomography && observation.motionValid) {
      this.latestHomography = {
        matrix: observation.observedHomography,
        timestampMs: observation.timestampMs
      };
    }
    return { accepted: true, reason: "accepted", quality: this.snapshot() };
  }

  freshHomographyAt(nowMs: number): Mat3 | null {
    if (!this.latestHomography) return null;
    const ageMs = nowMs - this.latestHomography.timestampMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.thresholds.maxResultAgeMs) {
      return null;
    }
    return this.latestHomography.matrix;
  }
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
