import { afterEach, expect, it, vi } from "vitest";
import { createBrowserCalibrationRuntime } from "./browserCalibration";

afterEach(() => vi.unstubAllGlobals());

it("keeps portrait camera orientation when the calibration card is wider than tall", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("screen", { orientation: { angle: 0 } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const stream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 720, height: 1280 }) }]
  } as unknown as MediaStream;
  const runtime = createBrowserCalibrationRuntime(stream);
  try {
    const capture = runtime.feed.captureOrientation(1.4);
    for (let i = 0; i < 5; i++) {
      const event = new Event("deviceorientation");
      Object.assign(event, { alpha: 0, beta: 80, gamma: 0 });
      window.dispatchEvent(event);
    }
    await capture;
    const viewport = { widthPx: 330, heightPx: 288 };
    const near = runtime.screenPointToGround({ xPx: 165, yPx: 245 }, viewport);
    const far = runtime.screenPointToGround({ xPx: 165, yPx: 144 }, viewport);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    // With an upright, forward-facing camera, a higher centre tap is farther
    // along the road, even when object-fit crops the video inside a wide card.
    expect(near![0]).toBeCloseTo(0);
    expect(far![0]).toBeCloseTo(0);
    expect(far![2] - near![2]).toBeGreaterThan(2);
  } finally {
    runtime.dispose();
  }
});
