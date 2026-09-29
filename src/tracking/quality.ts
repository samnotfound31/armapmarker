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
  weakConsecutiveFrames: 1,
  realignInlierCount: 10,
  realignConsecutiveFrames: 30,
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
  private poorSinceMs: number | null = null;
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

    this.poorSinceMs = poor ? this.poorSinceMs ?? observation.timestampMs : null;
    const sustainedFailure = this.criticalFrames >= this.thresholds.realignConsecutiveFrames ||
      (this.poorSinceMs !== null && observation.timestampMs - this.poorSinceMs >= 3_000);
    if (sustainedFailure) {
      this.currentState = "realign";
      this.recoveryFrames = 0;
    } else if (poor) {
      this.recoveryFrames = 0;
      if (this.currentState !== "realign" && this.poorFrames >= this.thresholds.weakConsecutiveFrames) {
        this.currentState = "weak";
      }
    } else if (acquisitionReady) {
      this.recoveryFrames = stable ? this.recoveryFrames + 1 : 0;
      if ((!this.hasLocked && this.currentState !== "realign") ||
          this.recoveryFrames >= this.thresholds.recoveryConsecutiveFrames) {
        this.hasLocked = true;
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
      medianReprojectionErrorPx: reprojectionError,
      confidence: this.currentState === "realign" ? 0 : poor ? 0.25 :
        this.currentState === "locked" ? Math.min(1, inlierRatio) : 0.4,
      visualUpdate: observation.motionValid ? "valid" : "rejected"
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
