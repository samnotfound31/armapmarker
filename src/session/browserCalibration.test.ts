import { afterEach, expect, it, vi } from "vitest";
import { createBrowserCalibrationRuntime } from "./browserCalibration";
import { applyMat4ToPoint, GEOGRAPHIC_EARTH_FROM_GROUND } from "../geometry/groundCalibration";

const location = { point: { lat: 20.353, lng: 85.819 }, accuracyMeters: 5, timestampMs: Date.now() };

afterEach(() => vi.unstubAllGlobals());

it("keeps portrait camera orientation when the calibration card is wider than tall", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("screen", { orientation: { angle: 0 } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const stream = {
    getVideoTracks: () => [{ getSettings: () => ({ width: 720, height: 1280 }) }]
  } as unknown as MediaStream;
  const runtime = createBrowserCalibrationRuntime(stream, undefined, location);
  try {
    const capture = runtime.feed.captureOrientation(1.4);
    for (let i = 0; i < 5; i++) {
      const event = new Event("deviceorientation");
      Object.assign(event, { alpha: 0, beta: 80, gamma: 0, webkitCompassHeading: 0, webkitCompassAccuracy: 5 });
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
    // WMM corrects magnetic north; preserve its small geographic east component.
    expect(Math.abs(near![0]!)).toBeLessThan(0.2);
    expect(Math.abs(far![0]!)).toBeLessThan(0.2);
    expect(far![2] - near![2]).toBeGreaterThan(2);
  } finally {
    runtime.dispose();
  }
});

it("captures geographic east yaw independently of Safari's arbitrary alpha", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("screen", { orientation: { angle: 0 } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const stream = { getVideoTracks: () => [{ getSettings: () => ({ width: 720, height: 1280 }) }] } as unknown as MediaStream;
  const runtime = createBrowserCalibrationRuntime(stream, undefined, location);
  try {
    const promise = runtime.feed.captureOrientation();
    for (let i = 0; i < 5; i++) {
      const event = new Event("deviceorientation");
      Object.assign(event, { alpha: 123, beta: 80, gamma: 0, webkitCompassHeading: 90, webkitCompassAccuracy: 5 });
      window.dispatchEvent(event);
    }
    const capture = await promise;
    expect(capture.absoluteHeading?.usable).toBe(true);
    expect(capture.earthFromGroundAtLock).toEqual(GEOGRAPHIC_EARTH_FROM_GROUND);
    const northRoutePoint = applyMat4ToPoint(capture.cameraFromGroundAtLock, [0, 0, 5]);
    expect(northRoutePoint[0]).toBeLessThan(-4.5);
    expect(northRoutePoint[2]).toBeLessThan(0.5);
  } finally { runtime.dispose(); }
});

it("returns heading-unavailable for relative samples without claiming geographic lock", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const stream = { getVideoTracks: () => [{ getSettings: () => ({ width: 720, height: 1280 }) }] } as unknown as MediaStream;
  const runtime = createBrowserCalibrationRuntime(stream, undefined, location);
  try {
    const promise = runtime.feed.captureOrientation();
    for (let i = 0; i < 5; i++) {
      const event = new Event("deviceorientation");
      Object.assign(event, { alpha: 0, beta: 80, gamma: 0, absolute: false });
      window.dispatchEvent(event);
    }
    const capture = await promise;
    expect(capture.absoluteHeading?.usable).toBe(false);
    expect(capture.absoluteHeading?.headingRad).toBeNull();
  } finally { runtime.dispose(); }
});
