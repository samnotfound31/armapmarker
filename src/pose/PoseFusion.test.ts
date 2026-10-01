import { describe, expect, it } from "vitest";
import type {
  GroundCalibration,
  Mat3,
  Mat4,
  TrackingQuality
} from "../domain/types";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { applyMat3ToPixel } from "../geometry/displayTransform";
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
  it("rejects invalid visual data while retaining the last good correction and live sensor pose", () => {
    const fusion = new PoseFusion(testCalibration());
    fusion.updateVisual({ timestampMs: 1000, keyframeId: 1, imageHomography: TRANSLATED, quality: LOCKED_QUALITY });
    expect(fusion.updateVisual({ timestampMs: 1100, keyframeId: 1,
      imageHomography: [-1,0,0,0,1,0,0,0,1], quality: LOCKED_QUALITY })).toBe(false);
    expect(fusion.snapshot(1100).visualCorrection.imageHomography).toEqual(TRANSLATED);
  });

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

  it("retains weak and stale registration without animating geometry to identity",()=>{
    const fusion=new PoseFusion(testCalibration());fusion.updateVisual({timestampMs:1000,keyframeId:1,imageHomography:TRANSLATED,quality:WEAK_QUALITY});
    expect(fusion.snapshot(1800).visualCorrection.imageHomography).toEqual(TRANSLATED);
  });

  it("preserves scale, shear, and projective terms without weighting geometry by confidence", () => {
    const projective: Mat3 = [
      1.02, 0.01, 0.0001,
      0.02, 0.98, -0.00005,
      12, -8, 1
    ];
    const fusion = new PoseFusion(testCalibration(), {
      maxFreshVisualAgeMs: 250,
      visualFadeDurationMs: 500,
      weakVisualWeight: 0.45,
      maxVisualDisplacementPx: 120,
      maxVisualConditionNumber: 20
    });
    fusion.updateVisual({
      timestampMs: 1000,
      keyframeId: 1,
      imageHomography: projective,
      quality: WEAK_QUALITY
    });

    expect(fusion.snapshot(1000).visualCorrection.imageHomography).toEqual(projective);
  });

  it("bounds full-image correction and rejects out-of-order updates", () => {
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
    ).toBe(false);
    expect(
      fusion.updateVisual({
        timestampMs: 999,
        keyframeId: 1,
        imageHomography: IDENTITY_MAT3,
        quality: LOCKED_QUALITY
      })
    ).toBe(false);

    const matrix = fusion.snapshot(1000).visualCorrection.imageHomography;
    for (const point of [
      { xPx: 0, yPx: 0 },
      { xPx: 1280, yPx: 0 },
      { xPx: 0, yPx: 720 },
      { xPx: 1280, yPx: 720 },
      { xPx: 640, yPx: 360 }
    ]) {
      const transformed = applyMat3ToPixel(matrix, point);
      expect(Math.hypot(transformed.xPx - point.xPx, transformed.yPx - point.yPx))
        .toBeLessThanOrEqual(80.001);
    }
    expect(matrix).toEqual(IDENTITY_MAT3);
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
