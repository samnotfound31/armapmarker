import { quat, mat3, mat4 } from "gl-matrix";
import type { Mat4 } from "../domain/types";
import { STABILIZATION_CONFIG as C } from "./stabilizationConfig";
export type Quaternion = [
    number,
    number,
    number,
    number
];
type Entry = {
    time: number;
    q: Quaternion;
};
export class AttitudeEstimator {
    private entries: Entry[] = [];
    private q: Quaternion;
    private time: number;
    private observationTime: number;
    private rate: [
        number,
        number,
        number
    ] = [0, 0, 0];
    private rateTime = -Infinity;
    private previousObserved: Quaternion;
    private previousInnovation: [
        number,
        number,
        number
    ] = [0, 0, 0];
    private consistent = 0;
    private quarantineSince: number | null = null;
    private readonly handedness: number;
    private innovation = 0;
    private observedAngles = [0, 0, 0];
    constructor(initial: Mat4, time = 0) {
        const r = mat3.fromMat4(mat3.create(), initial as unknown as mat4);
        this.handedness = mat3.determinant(r) < 0 ? -1 : 1;
        this.q = this.fromMatrix(initial);
        this.previousObserved = [...this.q];
        this.time = time;
        this.observationTime = time;
        this.entries.push({ time, q: [...this.q] });
    }
    observe(matrix: Mat4, time: number): boolean {
        if (!matrix.every(Number.isFinite) || time < this.time)
            return false;
        const observed = this.fromMatrix(matrix);
        this.observedAngles = angles(matrix);
        // Gyro propagation and orientation observations have independent clocks.
        // A rate callback just before this observation must not shrink its gain.
        const dt = Math.max(.001, Math.min(.1, (time - this.observationTime) / 1000));
        this.observationTime = time;
        const predicted = this.predict(time, Math.min(100, time - this.time));
        const error = quat.multiply(quat.create(), observed, quat.conjugate(quat.create(), predicted));
        if (error[3] < 0)
            quat.scale(error, error, -1);
        const axisLength = Math.hypot(error[0], error[1], error[2]);
        // atan2 preserves small innovations in the Float32 quaternion boundary.
        const angle = 2 * Math.atan2(axisLength, Math.max(0, error[3]));
        this.innovation = angle;
        const axis: [
            number,
            number,
            number
        ] = axisLength > 1e-8 ? [error[0] / axisLength, error[1] / axisLength, error[2] / axisLength] : [0, 0, 0];
        const supported = time - this.rateTime <= 100;
        if (angle > C.compassJumpRad) {
            this.quarantineSince ??= time;
            if (time - this.quarantineSince < 300) {
                this.store(predicted, time);
                return false;
            }
        }
        else
            this.quarantineSince = null;
        const r = mat4.fromQuat(mat4.create(), predicted);
        const up = [r[4], r[5], r[6]];
        const along = axis[0] * up[0]! + axis[1] * up[1]! + axis[2] * up[2]!;
        const innovation: [
            number,
            number,
            number
        ] = axis.map(v => v * angle) as [
            number,
            number,
            number
        ];
        const agreement = innovation.reduce((sum, v, i) => sum + v * this.previousInnovation[i]!, 0);
        this.consistent = agreement > 0 ? this.consistent + 1 : 0;
        this.previousInnovation = innovation;
        const observedDelta = 2 * Math.acos(Math.min(1, Math.abs(quat.dot(observed, this.previousObserved))));
        this.previousObserved = observed;
        let correction: Quaternion;
        if (supported) {
            const yawGain = 1 - Math.exp(-dt * 1000 / C.yawCorrectionMs), tiltGain = 1 - Math.exp(-dt * 1000 / C.tiltCorrectionMs);
            const v = axis.map((a, i) => angle * (a * tiltGain + up[i]! * along * (yawGain - tiltGain)));
            const length = Math.hypot(...v);
            correction = length > 1e-8 ? Array.from(quat.setAxisAngle(quat.create(), v.map(x => x / length), length)) as Quaternion : [0, 0, 0, 1];
            this.store(Array.from(quat.normalize(quat.create(), quat.multiply(quat.create(), correction, predicted))) as Quaternion, time);
        }
        else {
            // Adaptive fallback: coherent deliberate motion gets higher bandwidth; stationary noise does not.
            const fast = angle > .04 || (this.consistent >= 2 && observedDelta / dt > .35);
            const gain = 1 - Math.exp(-dt / (this.quarantineSince !== null ? 1 : fast ? .012 : .12));
            this.store(Array.from(quat.slerp(quat.create(), predicted, observed, gain)) as Quaternion, time);
        }
        return true;
    }
    updateRate(rate: [
        number,
        number,
        number
    ], time: number) {
        if (!rate.every(Number.isFinite) || Math.hypot(...rate) > 20 || time < this.rateTime)
            return;
        if (time > this.time)
            this.store(this.predict(time, Math.min(100, time - this.time)), time);
        this.rate = [...rate];
        this.rateTime = time;
    }
    sample(time: number) {
        let q = this.q;
        const next = this.entries.findIndex(e => e.time >= time);
        if (next === 0)
            q = this.entries[0]!.q;
        else if (next > 0) {
            const a = this.entries[next - 1]!, b = this.entries[next]!;
            q = Array.from(quat.slerp(quat.create(), a.q, b.q, (time - a.time) / Math.max(1, b.time - a.time))) as Quaternion;
        }
        else
            q = this.predict(time, C.predictionMs);
        const m = Array.from(mat4.fromQuat(mat4.create(), q));
        for (let i = 8; i < 11; i++)
            m[i] = m[i]! * this.handedness;
        return { observedAnglesDeg: [...this.observedAngles], estimatedAnglesDeg: angles(m as unknown as Mat4), quaternion: [...q] as Quaternion, cameraRotation: m as unknown as Mat4, angularRateRadPerSecond: Math.hypot(...this.rate), innovationRad: this.innovation, sensorAgeMs: Math.max(0, time - this.time), predictionMs: Math.max(0, Math.min(C.predictionMs, time - this.time)), gyroAvailable: time - this.rateTime < 150 };
    }
    private fromMatrix(m: Mat4): Quaternion { const r = mat3.fromMat4(mat3.create(), m as unknown as mat4); for (let i = 6; i < 9; i++)
        r[i] = r[i]! * this.handedness; return Array.from(quat.normalize(quat.create(), quat.fromMat3(quat.create(), r))) as Quaternion; }
    private predict(time: number, limit: number): Quaternion {
        if (time - this.rateTime > 150 || time <= this.time)
            return [...this.q];
        const seconds = Math.min(limit, time - this.time) / 1000;
        const speed = Math.hypot(...this.rate);
        if (speed < 1e-8)
            return [...this.q];
        const delta = quat.setAxisAngle(quat.create(), this.rate.map(v => v / speed), Math.min(speed * seconds, limit <= C.predictionMs ? C.maxPredictionRad : Infinity));
        return Array.from(quat.normalize(quat.create(), quat.multiply(quat.create(), delta, this.q))) as Quaternion;
    }
    private store(q: Quaternion, time: number) { this.q = q; this.time = time;
        const entry={time,q:[...q] as Quaternion};
        if(this.entries.at(-1)?.time===time)this.entries[this.entries.length-1]=entry;
        else this.entries.push(entry);
        while (this.entries.length > 2 && this.entries[1]!.time < time - C.historyMs)
        this.entries.shift(); }
}
function angles(m: Mat4): number[] { return [Math.atan2(m[8], m[0]), Math.atan2(-m[9], Math.hypot(m[8], m[10])), Math.atan2(m[1], m[5])].map(v => v * 180 / Math.PI); }
