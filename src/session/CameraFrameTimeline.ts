export type CameraFrameStamp = Readonly<{
    frameId: number;
    cameraGeneration: number;
    imageTimeMs: number;
    displayTimeMs: number;
    timestampSource: "capture" | "presentation";
    width: number;
    height: number;
    orientation: number;
}>;
export class CameraFrameTimeline {
    private frame = 0;
    private generation = 1;
    private format = "";
    private last = -Infinity;
    stamp(input: {
        nowMs: number;
        captureTime?: number;
        expectedDisplayTime?: number;
        width: number;
        height: number;
        orientation: number;
    }): CameraFrameStamp {
        const format = `${input.width}/${input.height}/${input.orientation}`;
        if (this.format && this.format !== format)
            this.generation++;
        this.format = format;
        const capture = Number.isFinite(input.captureTime) && input.captureTime! >= 0 && input.captureTime! <= input.nowMs;
        const imageTimeMs = Math.max(this.last, capture ? input.captureTime! : input.nowMs);
        this.last = imageTimeMs;
        return Object.freeze({ frameId: ++this.frame, cameraGeneration: this.generation, imageTimeMs, displayTimeMs: input.expectedDisplayTime ?? input.nowMs, timestampSource: capture ? "capture" : "presentation", width: input.width, height: input.height, orientation: input.orientation });
    }
    reset() { this.generation++; this.last = -Infinity; this.format = ""; }
}
