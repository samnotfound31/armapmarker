import { STABILIZATION_CONFIG as C } from "./stabilizationConfig";
type Position = [
    number,
    number,
    number
];
export class RenderPositionEstimator {
    private history: Array<{
        time: number;
        p: Position;
    }> = [];
    private velocity: Position = [0, 0, 0];
    private lastActual: Position | null = null;
    constructor(position: Position, time: number) { this.history.push({ time, p: [...position] }); }
    update(actual: Position, time: number, accuracy = 5): boolean {
        if (!actual.every(Number.isFinite) || time < this.history.at(-1)!.time)
            return false;
        const previous = this.history.at(-1)!;
        const predicted = this.sample(time);
        const delta = actual.map((v, i) => v - predicted[i]!) as Position;
        const reset = Math.hypot(delta[0], delta[2]) > C.positionResetMeters;
        const seconds = Math.max(.1, (time - previous.time) / 1000);
        if (this.lastActual && !reset) {
            const speed = actual.map((v, i) => (v - this.lastActual![i]!) / seconds) as Position;
            const magnitude = Math.hypot(speed[0], speed[2]);
            const scale = Math.min(1, C.maxWalkingSpeedMetersPerSecond / Math.max(.01, magnitude));
            this.velocity = [speed[0] * scale, 0, speed[2] * scale];
        }
        else
            this.velocity = [0, 0, 0];
        const gain = Math.max(.65, Math.min(.95, 1 - accuracy / 60));
        const p = reset ? [...actual] as Position : predicted.map((v, i) => v + gain * delta[i]!) as Position;
        p[1] = actual[1];
        this.history.push({ time, p });
        this.lastActual = [...actual];
        while (this.history.length > 2 && this.history[1]!.time < time - C.historyMs)
            this.history.shift();
        return !reset;
    }
    sample(time: number): Position {
        const next = this.history.findIndex(e => e.time >= time);
        if (next === 0)
            return [...this.history[0]!.p];
        if (next > 0) {
            const a = this.history[next - 1]!, b = this.history[next]!;
            const f = (time - a.time) / Math.max(1, b.time - a.time);
            return a.p.map((v, i) => v + f * (b.p[i]! - v)) as Position;
        }
        const last = this.history.at(-1)!;
        const elapsed = Math.max(0, Math.min(C.positionPredictionMs, time - last.time)) / 1000;
        const d = this.velocity.map(v => v * elapsed);
        const scale = Math.min(1, C.maxPositionPredictionMeters / Math.max(.001, Math.hypot(d[0]!, d[2]!)));
        return last.p.map((v, i) => v + d[i]! * scale) as Position;
    }
}
