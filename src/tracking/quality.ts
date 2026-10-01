import type { Mat3, TrackingQuality, TrackingState } from "../domain/types";
import type { TrackingObservation, TrackingThresholds, TrackingUpdateOutcome } from "./types";
export const DEFAULT_TRACKING_THRESHOLDS: Readonly<TrackingThresholds> = {
    initialCandidateCount: 30, initialInlierCount: 20, weakInlierCount: 15,
    weakInlierRatio: 0.55, weakMedianReprojectionErrorPx: 3, weakConsecutiveFrames: 3,
    realignInlierCount: 10, realignConsecutiveFrames: 30, recoveryConsecutiveFrames: 2,
    maxResultAgeMs: 250, acquisitionFrames: 5, acquisitionSpanMs: 300, weakAfterMs: 250, realignAfterMs: 1800
};
const EMPTY: TrackingQuality = { state: "weak", featureCount: 0, inlierCount: 0, inlierRatio: 0, medianReprojectionErrorPx: Infinity };
/** Only fresh, anchor-consistent observations advance acquisition/recovery. Silence uses the same clock. */
export class TrackingQualityGate {
    private quality: TrackingQuality = { ...EMPTY };
    private startedAt: number | null = null;
    private lastGood: number | null = null;
    private lastObservation = -Infinity;
    private goodSince = 0;
    private goodCount = 0;
    private stateSince = 0;
    private latestHomography: {
        matrix: Mat3;
        timestampMs: number;
    } | null = null;
    constructor(private readonly thresholds: Readonly<TrackingThresholds> = DEFAULT_TRACKING_THRESHOLDS) { }
    get state(): TrackingState { return this.quality.state; }
    get timeInStateMs() { return (now: number) => Math.max(0, now - this.stateSince); }
    snapshot(): TrackingQuality { return { ...this.quality }; }
    tick(now: number): TrackingQuality {
        if (this.startedAt === null)
            this.startedAt = now;
        const age = now - (this.lastGood ?? this.startedAt);
        if (age >= (this.thresholds.weakAfterMs ?? 250))
            this.goodCount = 0;
        if (age >= (this.thresholds.realignAfterMs ?? 1800))
            this.transition("realign", now);
        else if (age >= (this.thresholds.weakAfterMs ?? 250))
            this.transition("weak", now);
        return this.snapshot();
    }
    update(o: TrackingObservation, receivedAtMs = o.timestampMs): TrackingUpdateOutcome {
        const age = receivedAtMs - o.timestampMs;
        if (!Number.isFinite(age) || age < 0 || age > this.thresholds.maxResultAgeMs || o.timestampMs <= this.lastObservation)
            return { accepted: false, reason: "stale", quality: this.snapshot() };
        this.startedAt ??= o.timestampMs;
        this.lastObservation = o.timestampMs;
        this.tick(receivedAtMs);
        const count = Math.max(0, Math.floor(o.candidateCount));
        const inliers = Math.max(0, Math.min(count, o.inlierCount));
        const ratio = count ? inliers / count : 0;
        const strong = o.motionValid && count >= this.thresholds.initialCandidateCount && inliers >= this.thresholds.initialInlierCount && ratio >= this.thresholds.weakInlierRatio && o.medianReprojectionErrorPx <= this.thresholds.weakMedianReprojectionErrorPx;
        if (strong) {
            if (!this.goodCount)
                this.goodSince = o.timestampMs;
            this.goodCount++;
            this.lastGood = o.timestampMs;
            if (this.goodCount >= (this.thresholds.acquisitionFrames ?? 5) && o.timestampMs - this.goodSince >= (this.thresholds.acquisitionSpanMs ?? 300))
                this.transition("locked", receivedAtMs);
            else if (this.state !== "locked" && this.goodCount >= this.thresholds.recoveryConsecutiveFrames)
                this.transition("recovering", receivedAtMs);
            if (o.observedHomography)
                this.latestHomography = { matrix: o.observedHomography, timestampMs: o.timestampMs };
        }
        else {
            this.goodCount = 0;
        }
        this.quality = { ...this.quality, featureCount: count, inlierCount: inliers, inlierRatio: ratio, medianReprojectionErrorPx: o.medianReprojectionErrorPx, confidence: this.state === "locked" ? ratio : this.state === "realign" ? 0 : .4, visualUpdate: o.motionValid ? "valid" : "rejected" };
        return { accepted: o.motionValid, reason: o.motionValid ? "accepted" : "rejected", quality: this.snapshot() };
    }
    freshHomographyAt(now: number): Mat3 | null { return this.latestHomography && now - this.latestHomography.timestampMs >= 0 && now - this.latestHomography.timestampMs <= this.thresholds.maxResultAgeMs ? this.latestHomography.matrix : null; }
    private transition(state: TrackingState, now: number) { if (state !== this.quality.state) {
        this.quality = { ...this.quality, state };
        this.stateSince = now;
    } }
}
