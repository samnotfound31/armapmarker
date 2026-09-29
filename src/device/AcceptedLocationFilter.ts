import type { LocationFix } from "./location";

export type LocationConfidence = "GOOD" | "DEGRADED" | "REJECTED";
export type LocationRejectionReason =
  | "accepted"
  | "invalid"
  | "accuracy"
  | "stale"
  | "future"
  | "out-of-order";

export type AcceptedLocationDecision = {
  accepted: boolean;
  status: LocationConfidence;
  reason: LocationRejectionReason;
  /** Monotonic application time, never the source's epoch timestamp. */
  timestampMs: number;
  fix?: LocationFix;
};

export type LocationFreshness = {
  usable: boolean;
  ageMs: number | null;
  status: LocationConfidence;
};

export type AcceptedLocationConfig = {
  maximumUsableAccuracyMeters: number;
  maximumDegradedAccuracyMeters: number;
  maximumSourceAgeMs: number;
  maximumFutureOffsetMs: number;
  usableFixTimeoutMs: number;
};

export const DEFAULT_LOCATION_CONFIG: AcceptedLocationConfig = {
  maximumUsableAccuracyMeters: 15,
  maximumDegradedAccuracyMeters: 25,
  maximumSourceAgeMs: 3000,
  maximumFutureOffsetMs: 1000,
  usableFixTimeoutMs: 5000
};

/** Validates source metadata before any progress or camera-position update. */
export class AcceptedLocationFilter {
  private lastSourceTimestampMs: number | null = null;
  private lastAcceptedAtMs: number | null = null;
  private latestStatus: LocationConfidence = "REJECTED";
  private acceptedFix: LocationFix | null = null;
  private readonly config: AcceptedLocationConfig;

  constructor(config: Partial<AcceptedLocationConfig> = {}) {
    this.config = { ...DEFAULT_LOCATION_CONFIG, ...config };
  }

  get lastAcceptedFix(): LocationFix | null {
    return this.acceptedFix;
  }

  accept(fix: LocationFix, epochNowMs: number, monotonicNowMs: number): AcceptedLocationDecision {
    const reject = (
      reason: LocationRejectionReason,
      status: LocationConfidence = "REJECTED"
    ): AcceptedLocationDecision => {
      this.latestStatus = status;
      return { accepted: false, status, reason, timestampMs: monotonicNowMs };
    };
    if (
      !Number.isFinite(fix.point.lat) || Math.abs(fix.point.lat) > 90 ||
      !Number.isFinite(fix.point.lng) || Math.abs(fix.point.lng) > 180 ||
      !Number.isFinite(fix.accuracyMeters) || fix.accuracyMeters < 0 ||
      !Number.isFinite(fix.timestampMs) ||
      !Number.isFinite(epochNowMs) ||
      !Number.isFinite(monotonicNowMs) || monotonicNowMs < 0
    ) {
      return reject("invalid");
    }
    if (epochNowMs - fix.timestampMs > this.config.maximumSourceAgeMs) return reject("stale");
    if (fix.timestampMs - epochNowMs > this.config.maximumFutureOffsetMs) return reject("future");
    if (this.lastSourceTimestampMs !== null && fix.timestampMs <= this.lastSourceTimestampMs) {
      return reject("out-of-order");
    }
    this.lastSourceTimestampMs = fix.timestampMs;
    if (fix.accuracyMeters > this.config.maximumUsableAccuracyMeters) {
      return reject("accuracy", fix.accuracyMeters <= this.config.maximumDegradedAccuracyMeters
        ? "DEGRADED" : "REJECTED");
    }
    this.acceptedFix = fix;
    this.lastAcceptedAtMs = monotonicNowMs - Math.max(0, epochNowMs - fix.timestampMs);
    this.latestStatus = "GOOD";
    return { accepted: true, status: "GOOD", reason: "accepted", timestampMs: monotonicNowMs, fix };
  }

  freshness(monotonicNowMs: number): LocationFreshness {
    const ageMs = this.lastAcceptedAtMs === null ? null : Math.max(0, monotonicNowMs - this.lastAcceptedAtMs);
    const usable = ageMs !== null && Number.isFinite(ageMs) &&
      ageMs <= this.config.usableFixTimeoutMs && this.latestStatus === "GOOD";
    return { usable, ageMs, status: usable ? "GOOD" : this.latestStatus === "DEGRADED" ? "DEGRADED" : "REJECTED" };
  }
}
