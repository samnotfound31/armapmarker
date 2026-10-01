import type { CameraIntrinsics, GroundCalibration, Mat3, Mat4, NavigationGeographicState, PoseEstimate } from "../domain/types";
import type { CameraFrameStamp } from "../session/CameraFrameTimeline";
import type { TrackerResult, TrackingFrameContext } from "../tracking/types";
import type { GpsPoseUpdate, SensorPoseUpdate } from "./PoseFusion";
import { TrackingQualityGate } from "../tracking/quality";
import { AttitudeEstimator } from "./AttitudeEstimator";
import { RenderPositionEstimator } from "./RenderPositionEstimator";
import { STABILIZATION_CONFIG as C } from "./stabilizationConfig";
import { nominalGroundProjection, residualFromGroundMotion, transportCorrection, registrationDistance, IDENTITY_REGISTRATION as I, blendRegistration, warp } from "./groundRegistration";
import { invertHomography, multiplyHomographies } from "../tracking/residualHomography";
export type RenderPose = PoseEstimate & {
    overlayOpacity: number;
    groundFromRoute: Mat4;
    imageTime: number;
    cameraGeneration: number;
    nominalPoseRevision: number;
};
export type StabilityTelemetry = Record<string, number | string | boolean>;
type Nominal = {
    intrinsics: CameraIntrinsics;
    camera: Mat4;
    position: [
        number,
        number,
        number
    ];
    quaternion: [
        number,
        number,
        number,
        number
    ];
    plane: Mat3;
    time: number;
};
export class RenderPoseController {
    private readonly attitude: AttitudeEstimator;
    private readonly position: RenderPositionEstimator;
    private quality = new TrackingQualityGate();
    private frames = new Map<number, {
        context: TrackingFrameContext;
        nominal: Nominal;
    }>();
    private anchors = new Map<number, {
        plane: Mat3;
        correction: Mat3;
        time: number;
    }>();
    private visual: {
        correction: Mat3;
        nominal: Mat3;
        time: number;
        keyframe: number;
    } | null = null;
    private displayed: {
        context: TrackingFrameContext;
        nominal: Nominal;
    } | null = null;
    private generation = 1;
    private revision = 0;
    private progress: number;
    private geographic: NavigationGeographicState = "VALID";
    private lastCommit = -Infinity;
    private opacity = .55;
    private opacityTime = 0;
    private manual = { lateralMeters: 0, yawRad: 0 };
    private rejected = 0;
    private stale = 0;
    private lastReason = "initializing";
    private lastRejectedReason="none";
    private referenceTime=0;
    private correctionDelta = 0;
    private lastValidAttitudeTime = 0;
    private attitudeUncertain = false;
    private positionUncertain = false;
    private editing = false;
    private budgetExceeded = false;
    private registrationMeters = 0;
    private previousRender: Nominal | null = null;
    private metrics: StabilityTelemetry = { droppedFrames: 0, bitmapDelayMs: 0, workerProcessingMs: 0, resultAgeMs: 0 };
    noteTiming(values: StabilityTelemetry) { Object.assign(this.metrics, values); }
    noteDiscardedResult(){this.stale++;this.lastRejectedReason="stale-result";}
    noteDropped() { this.metrics.droppedFrames = Number(this.metrics.droppedFrames) + 1; }
    setAlignmentEditing(editing: boolean) { this.editing = editing; if (!editing)
        this.quality = new TrackingQualityGate(); }
    visualUnavailable(reason: string) { this.lastReason = reason;this.lastRejectedReason=reason; }
    constructor(private readonly calibration: GroundCalibration) {
        const time = calibration.lockedAtMs ?? 0;
        this.attitude = new AttitudeEstimator(calibration.cameraFromGroundAtLock, time);
        this.position = new RenderPositionEstimator([0, calibration.cameraHeightMeters, 0], time);
        this.progress = calibration.calibrationRouteDistanceMeters;
        if (calibration.manualAlignment)
            this.setManualAlignment(calibration.manualAlignment);
    }
    updateSensor(update: SensorPoseUpdate) { if (update.absoluteHeading?.usable === false)
        return false; const accepted = this.attitude.observe(update.cameraFromGround, update.timestampMs); if (accepted)
        this.lastValidAttitudeTime = update.timestampMs; this.attitudeUncertain = !accepted && update.timestampMs - this.lastValidAttitudeTime > 500; this.revision++; return accepted; }
    updateRate(rate: [
        number,
        number,
        number
    ], time: number) { this.attitude.updateRate(rate, time); this.revision++; }
    updateGps(update: GpsPoseUpdate, accuracy = 5) { this.positionUncertain = !this.position.update(update.cameraPositionGroundMeters, update.timestampMs, accuracy); this.progress = update.routeProgressMeters; this.revision++; if (this.positionUncertain)
        this.resetVisual(update.timestampMs); }
    setNavigation(progress: number, geographic: NavigationGeographicState) { this.progress = progress; this.geographic = geographic; }
    captureFrame(stamp: CameraFrameStamp): TrackingFrameContext {
        if (stamp.cameraGeneration !== this.generation) {
            this.generation = stamp.cameraGeneration;
            this.resetVisual(stamp.imageTimeMs);
            this.frames.clear();
        }
        if (this.displayed && stamp.frameId <= this.displayed.context.frameId)
            throw new RangeError("Camera frame is older than the displayed image.");
        this.metrics.cameraFrameIntervalMs = this.displayed ? stamp.imageTimeMs - this.displayed.context.imageTimeMs : 0;
        this.metrics.imagePoseOffsetMs = stamp.displayTimeMs - stamp.imageTimeMs;
        const nominal = this.nominal(stamp.imageTimeMs, stamp.width, stamp.height);
        const inverse = invertHomography(nominal.plane);
        const horizon = Math.abs(inverse[5]) > 1e-8 ? -(inverse[2] * stamp.width / 2 + inverse[8]) / inverse[5] : 0;
        const context = Object.freeze({ ...stamp, roadRoiTopRatio: Math.max(.15, Math.min(.8, (horizon + 20) / stamp.height)), nominalPlane: Object.freeze([...nominal.plane]) as unknown as Mat3, nominalPoseRevision: this.revision });
        const frame = { context, nominal };
        this.displayed = frame;
        this.frames.set(stamp.frameId, frame);
        for (const [id, f] of this.frames)
            if (f.context.imageTimeMs < stamp.imageTimeMs - C.historyMs)
                this.frames.delete(id);
        return context;
    }
    acceptTracking(result: TrackerResult, now: number): boolean {
        const context = result.context;
        const frame = context && this.frames.get(context.frameId);
        if (!context || !frame || context.cameraGeneration !== this.generation || frame.context.nominalPoseRevision !== context.nominalPoseRevision || context.imageTimeMs !== result.timestampMs || now - result.timestampMs > 250 || now < result.timestampMs || result.timestampMs <= this.lastCommit) {
            this.stale++;
            this.lastReason = "stale-or-incompatible-frame";
            this.lastRejectedReason=this.lastReason;
            return false;
        }
        this.noteTiming({sharpness:result.sharpness??0,originalFeatures:result.originalFeatureCount??result.quality.featureCount,trackedFeatures:result.quality.featureCount,workerProcessingMs:result.processingMs??0,resultAgeMs:now-result.timestampMs});
        if (result.status === "initializing") {
            if (result.quality.featureCount < 30 || (result.sharpness ?? 10) < 5){
                this.lastReason=result.quality.featureCount<30?"insufficient-initial-support":"blurred-initial-reference";
                this.lastRejectedReason=this.lastReason;this.rejected++;return false;
            }
            let referenceCorrection:Mat3;
            try{referenceCorrection=this.correctionAt(frame.nominal.plane);}catch(error){if(!(error instanceof RangeError))throw error;this.lastReason="incompatible-projection";return false;}
            this.anchors.set(result.keyframeId, { plane: frame.nominal.plane, correction: referenceCorrection, time: result.timestampMs });
            this.lastCommit = result.timestampMs;
            this.referenceTime=result.timestampMs;
            for(const id of this.anchors.keys())if(id!==result.keyframeId)this.anchors.delete(id);
            this.quality = new TrackingQualityGate();
            return true;
        }
        let correction: Mat3 | null = null;
        try {
            const anchor = this.anchors.get(result.keyframeId);
            if (anchor && result.referenceTimestampMs !== undefined && anchor.time !== result.referenceTimestampMs)
                throw new RangeError("reference-mismatch");
            if (result.quality.inlierCount < 20 || result.quality.inlierRatio < .55 || (result.spatialCoverage ?? 1) < .33 || result.quality.medianReprojectionErrorPx > 3 || (result.p90ReprojectionErrorPx ?? 0) > 4)
                throw new RangeError("insufficient-ground-support");
            if (result.status !== "tracked" || !result.visualHomography || !anchor)
                throw new RangeError(result.quality.rejectionReason ?? "missing-anchor");
            correction = residualFromGroundMotion(result.visualHomography, anchor.correction, anchor.plane, frame.nominal.plane);
            const previous = this.correctionAt(frame.nominal.plane);
            invertHomography(correction);
            const scale = context.width / 480;
            this.correctionDelta = registrationDistance(previous, correction, context.width, context.height);
            if (correction[0] * correction[4] - correction[1] * correction[3] <= 0 || registrationDistance(I, correction, context.width, context.height) > C.maxResidualPixelsAt480 * scale || this.correctionDelta > C.maxInnovationPixelsAt480 * scale)
                throw new RangeError("registration-innovation");
            if (this.registrationBudget(correction, frame.nominal.plane) > C.maxRegistrationMeters)
                throw new RangeError("registration-budget");
            if (this.visual && this.correctionDelta < 2 * scale)
                correction = blendRegistration(previous, correction, .35, context.width, context.height);
        }
        catch (error) {
            if (!(error instanceof RangeError))
                throw error;
            this.lastReason = error.message;
            this.lastRejectedReason=error.message;
            correction = null;
        }
        const q = result.quality;
        this.noteTiming({ originalFeatures: result.originalFeatureCount ?? q.featureCount, trackedFeatures: q.featureCount, inliers: q.inlierCount, inlierRatio: q.inlierRatio, spatialCoverage: result.spatialCoverage ?? 0, medianResidualPx: q.medianReprojectionErrorPx, p90ResidualPx: result.p90ReprojectionErrorPx ?? 0, resultAgeMs: now - result.timestampMs, workerProcessingMs: result.processingMs ?? 0 });
        this.quality.update({ timestampMs: result.timestampMs, candidateCount: q.featureCount, inlierCount: q.inlierCount, medianReprojectionErrorPx: q.medianReprojectionErrorPx, motionValid: Boolean(correction) }, now);
        if (!correction) {
            this.rejected++;
            return false;
        }
        this.visual = { correction, nominal: frame.nominal.plane, time: result.timestampMs, keyframe: result.keyframeId };
        this.lastCommit = result.timestampMs;
        this.lastReason = "accepted";
        this.positionUncertain = false;
        if (result.promoteCandidate) {
            this.referenceTime=result.timestampMs;
            this.anchors.set(result.keyframeId + 1, { plane: frame.nominal.plane, correction, time: result.timestampMs });
            for (const id of this.anchors.keys())
                if (id < result.keyframeId)
                    this.anchors.delete(id);
        }
        return true;
    }
    sampleDisplayFrame(now: number): RenderPose { return this.render(this.displayed?.nominal ?? this.nominal(now), now); }
    sample(time: number): RenderPose { return this.render(this.nominal(time), time); }
    setManualAlignment(value: {
        lateralMeters: number;
        yawRad: number;
    }) {
        if (!Number.isFinite(value.lateralMeters) || !Number.isFinite(value.yawRad) || Math.abs(value.lateralMeters) > C.maxLateralMeters || Math.abs(value.yawRad) > C.maxYawRad)
            throw new RangeError("Alignment exceeds its geographic registration allowance.");
        this.manual = { ...value };
    }
    getManualAlignment() { return { ...this.manual }; }
    telemetry(now: number): StabilityTelemetry {
        const a = this.attitude.sample(now), quality = this.quality.tick(now);
        return { ...this.metrics, observedYawDeg: a.observedAnglesDeg[0]!, observedPitchDeg: a.observedAnglesDeg[1]!, observedRollDeg: a.observedAnglesDeg[2]!, estimatedYawDeg: a.estimatedAnglesDeg[0]!, estimatedPitchDeg: a.estimatedAnglesDeg[1]!, estimatedRollDeg: a.estimatedAnglesDeg[2]!, registrationBudget: this.budgetExceeded ? "exceeded" : "within", registrationMeters: this.registrationMeters, trackingState: this.budgetExceeded ? "REALIGN" : quality.state.toUpperCase(), timeInStateMs: this.quality.timeInStateMs(now), gyroAvailable: a.gyroAvailable, angularRate: a.angularRateRadPerSecond, attitudeInnovationDeg: a.innovationRad * 180 / Math.PI, sensorAgeMs: a.sensorAgeMs, predictionMs: a.predictionMs, visualRejected: this.rejected, staleResults: this.stale, lastRejection: this.lastRejectedReason,lastMeasurement:this.lastReason, correctionInnovationPx: this.correctionDelta, keyframeAgeMs: Math.max(0,now-this.referenceTime), overlayOpacity: this.opacity, manualLateralMeters: this.manual.lateralMeters, manualYawDeg: this.manual.yawRad * 180 / Math.PI, cameraGeneration: this.generation, nominalRevision: this.revision, frameTimeMs: this.displayed?.context.imageTimeMs ?? 0, timestampSource: this.displayed?.context.timestampSource ?? "presentation" };
    }
    private render(n: Nominal, now: number): RenderPose {
        if (this.previousRender) {
            this.metrics.renderPositionDeltaMeters = Math.hypot(...n.position.map((v, i) => v - this.previousRender!.position[i]!));
            this.metrics.renderAngularDeltaDeg = 2 * Math.acos(Math.min(1, Math.abs(n.quaternion.reduce((a, v, i) => a + v * this.previousRender!.quaternion[i]!, 0)))) * 180 / Math.PI;
        }
        this.previousRender = n;
        let quality = this.quality.tick(now);
        const target = quality.state === "locked" ? 1 : quality.state === "realign" ? 0 : C.weakOpacity;
        const dt = Math.max(0, now - this.opacityTime);
        this.opacity += (target - this.opacity) * (1 - Math.exp(-dt / C.opacityTimeMs));
        this.opacityTime = Math.max(this.opacityTime, now);
        let correction: Mat3;
        try {
            correction = this.correctionAt(n.plane);
            this.registrationMeters = this.registrationBudget(correction, n.plane);
            this.budgetExceeded = this.registrationMeters > C.maxRegistrationMeters;
        }
        catch (error) {
            if (!(error instanceof RangeError))
                throw error;
            this.budgetExceeded = true;
            correction = I;
        }
        const valid = this.geographic === "VALID" && !this.attitudeUncertain && !this.positionUncertain && !this.budgetExceeded;
        try {
            this.metrics.correctionMagnitudePx = registrationDistance(I, correction, n.intrinsics.imageWidthPx, n.intrinsics.imageHeightPx);
        }
        catch (error) {
            if (!(error instanceof RangeError))
                throw error;
            this.metrics.correctionMagnitudePx = 0;
            this.budgetExceeded = true;
        }
        if (this.budgetExceeded)
            quality = { ...quality, state: "realign", rejectionReason: "registration-budget" };
        const offset = this.manualMatrix();
        return { timestampMs: n.time, imageTime: n.time, cameraGeneration: this.generation, nominalPoseRevision: this.displayed?.nominal===n?this.displayed.context.nominalPoseRevision:this.revision, cameraPositionGroundMeters: [...n.position], orientationQuaternion: [...n.quaternion], cameraFromGround: n.camera, renderIntrinsics: n.intrinsics, groundFromRoute: multiply4(offset, this.calibration.groundFromRoute), visualCorrection: { imageHomography: correction, keyframeId: this.visual?.keyframe ?? 0, timestampMs: this.visual?.time ?? n.time }, routeProgressMeters: this.progress, quality, geographicState: this.geographic, overlayOpacity: valid && !this.budgetExceeded ? (this.editing ? .35 : this.opacity) : 0 };
    }
    private nominal(time: number, width = this.calibration.intrinsics.imageWidthPx, height = this.calibration.intrinsics.imageHeightPx): Nominal {
        const a = this.attitude.sample(time), p = this.position.sample(time), r = a.cameraRotation;
        const camera: [
            ...Mat4
        ] = [r[0], r[1], r[2], 0, r[4], r[5], r[6], 0, r[8], r[9], r[10], 0, -(r[0] * p[0] + r[4] * p[1] + r[8] * p[2]), -(r[1] * p[0] + r[5] * p[1] + r[9] * p[2]), -(r[2] * p[0] + r[6] * p[1] + r[10] * p[2]), 1];
        const k = this.calibration.intrinsics, sx = width / k.imageWidthPx, sy = height / k.imageHeightPx;
        const intrinsics = { ...k, imageWidthPx: width, imageHeightPx: height, fxPx: k.fxPx * sx, fyPx: k.fyPx * sy, cxPx: k.cxPx * sx, cyPx: k.cyPx * sy };
        return { camera, position: p, quaternion: a.quaternion, plane: nominalGroundProjection(camera, intrinsics), time, intrinsics };
    }
    private correctionAt(n: Mat3): Mat3 { if (!this.visual)
        return I; if (n.every((v, i) => v === this.visual!.nominal[i]))
        return this.visual.correction; return transportCorrection(this.visual.correction, this.visual.nominal, n); }
    private resetVisual(time: number) { this.quality = new TrackingQualityGate(); this.visual = null; this.anchors.clear(); this.lastCommit = -Infinity; this.opacityTime = time; this.opacity = 0; }
    private registrationBudget(correction: Mat3, plane: Mat3): number {
        const residual = multiplyHomographies(invertHomography(plane), multiplyHomographies(correction, plane));
        const manual = this.manualMatrix(), g = this.calibration.groundFromRoute;
        let maximum = 0;
        for (const right of [-1, 1])
            for (const ahead of [3, 15, 28]) {
                const d = this.progress + ahead, x = g[0] * right + g[8] * d + g[12], z = g[2] * right + g[10] * d + g[14];
                const adjusted = warp(residual, manual[0] * x + manual[8] * z + manual[12], manual[2] * x + manual[10] * z + manual[14]);
                maximum = Math.max(maximum, Math.hypot(adjusted[0] - x, adjusted[1] - z));
            }
        return maximum;
    }
    private manualMatrix(): Mat4 {
        const g = this.calibration.groundFromRoute;
        const { lateralMeters: l, yawRad: y } = this.manual;
        const c = Math.cos(y), s = Math.sin(y);
        // Rotate about the route origin; the geographic route/GPS transform stays immutable.
        const x = g[12], z = g[14];
        return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x - c * x - s * z + g[0] * l, 0, z + s * x - c * z + g[2] * l, 1];
    }
}
function multiply4(a: Mat4, b: Mat4): Mat4 { const o = Array<number>(16).fill(0); for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
        for (let i = 0; i < 4; i++)
            o[c * 4 + r] = o[c * 4 + r]! + a[i * 4 + r]! * b[c * 4 + i]!; return o as unknown as Mat4; }
