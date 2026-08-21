import { describe, expect, it } from "vitest";
import type {
  GroundCalibration,
  Mat3,
  Mat4,
  TrackingQuality
} from "../domain/types";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import { PoseFusion } from "./PoseFusion";

const LOCKED_QUALITY: TrackingQuality = {
  state: "locked",
  featureCount: 40,
  inlierCount: 30,
  inlierRatio: 0.75,
  medianReprojectionErrorPx: 1
};
const WEAK_QUALITY: TrackingQuality = { ...LOCKED_QUALITY, state: "weak" };
const TRANSLATED: Mat3 = [1, 0, 0, 0, 1, 0, 40, -10, 1];

describe("PoseFusion", () => {
  it("keeps global route progress owned by GPS", () => {
    const fusion = new PoseFusion(testCalibration());
    fusion.updateGps({
      timestampMs: 1000,
      routeProgressMeters: 42,
      cameraPositionGroundMeters: [0, 1.4, 42]
    });
    fusion.updateVisual({
      timestampMs: 1010,
      keyframeId: 1,
      imageHomography: TRANSLATED,
      quality: LOCKED_QUALITY
    });

    expect(fusion.snapshot(1010).routeProgressMeters).toBe(42);
    expect(fusion.snapshot(1010).cameraFromGround[14]).toBe(-42);
  });

  it("keeps a fresh visual residual while fast sensor pose updates arrive", () => {
    const fusion = new PoseFusion(testCalibration());
    fusion.updateVisual({
      timestampMs: 1000,
      keyframeId: 1,
      imageHomography: TRANSLATED,
      quality: LOCKED_QUALITY
    });
    const rotatedSensor: Mat4 = [
      0, 0, -1, 0,
      0, 1, 0, 0,
      1, 0, 0, 0,
      0, 0, 0, 1
    ];
    fusion.updateSensor({
      timestampMs: 1033,
      cameraFromGround: rotatedSensor,
      orientationQuaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2]
    });

    const snapshot = fusion.snapshot(1033);
    expect(snapshot.cameraFromGround.slice(0, 12)).toEqual(rotatedSensor.slice(0, 12));
    expect(snapshot.cameraFromGround[13]).toBeCloseTo(-1.4);
    expect(snapshot.visualCorrection.imageHomography[6]).toBeCloseTo(40);
  });

  it("fades weak and stale visual corrections smoothly to identity", () => {
    const fusion = new PoseFusion(testCalibration());
    fusion.updateVisual({
      timestampMs: 1000,
      keyframeId: 1,
      imageHomography: TRANSLATED,
      quality: WEAK_QUALITY
    });

    const weak = fusion.snapshot(1000).visualCorrection.imageHomography[6];
    const fading = fusion.snapshot(1500).visualCorrection.imageHomography[6];
    const stale = fusion.snapshot(1800).visualCorrection.imageHomography;
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeLessThan(40);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(weak);
    expect(stale).toEqual(IDENTITY_MAT3);
  });

  it("bounds heading correction and rejects out-of-order updates", () => {
    const fusion = new PoseFusion(testCalibration());
    const rotation = 0.5;
    const visual: Mat3 = [
      Math.cos(rotation), Math.sin(rotation), 0,
      -Math.sin(rotation), Math.cos(rotation), 0,
      0, 0, 1
    ];
    expect(
      fusion.updateVisual({
        timestampMs: 1000,
        keyframeId: 2,
        imageHomography: visual,
        quality: LOCKED_QUALITY
      })
    ).toBe(true);
    expect(
      fusion.updateVisual({
        timestampMs: 999,
        keyframeId: 1,
        imageHomography: IDENTITY_MAT3,
        quality: LOCKED_QUALITY
      })
    ).toBe(false);

    const matrix = fusion.snapshot(1000).visualCorrection.imageHomography;
    expect(Math.atan2(matrix[1], matrix[0])).toBeCloseTo(0.12);
  });
});

function testCalibration(): GroundCalibration {
  return {
    stage: "locked",
    cameraHeightMeters: 1.4,
    intrinsics: buildApproximateIntrinsics(1280, 720),
    imageToScreen: IDENTITY_MAT3,
    groundFromRoute: IDENTITY_MAT4,
    cameraFromGroundAtLock: IDENTITY_MAT4,
    calibrationRouteDistanceMeters: 0,
    lockedAtMs: 900
  };
}
