import { describe, expect, it } from "vitest";
import { LANDSCAPE_VIDEO } from "../test/geometryFixtures";
import {
  CALIBRATION_CONFIG,
  buildApproximateIntrinsics,
  imagePixelToCameraRay
} from "./intrinsics";

describe("buildApproximateIntrinsics", () => {
  it("builds focal length from the configured horizontal FOV", () => {
    const k = buildApproximateIntrinsics(1920, 1080, 65);

    expect(k.fxPx).toBeCloseTo(1920 / (2 * Math.tan((65 * Math.PI) / 360)));
    expect(k.fyPx).toBe(k.fxPx);
    expect(k.cxPx).toBe(960);
    expect(k.cyPx).toBe(540);
    expect(k.source).toBe("assumed-fov");
  });

  it("keeps the experimental FOV in one calibration config", () => {
    const k = buildApproximateIntrinsics(
      LANDSCAPE_VIDEO.widthPx,
      LANDSCAPE_VIDEO.heightPx
    );
    expect(k.effectiveHorizontalFovDeg).toBe(
      CALIBRATION_CONFIG.effectiveHorizontalFovDeg
    );
  });

  it("creates a forward optical-centre ray and rejects invalid dimensions", () => {
    const k = buildApproximateIntrinsics(1920, 1080);
    expect(imagePixelToCameraRay({ xPx: 960, yPx: 540 }, k)).toEqual([0, 0, 1]);
    expect(() => buildApproximateIntrinsics(0, 1080)).toThrow(/dimensions/i);
  });
});
