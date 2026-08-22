import { describe, expect, it } from "vitest";
import type { Mat3 } from "../domain/types";
import {
  buildSensorRotationHomography,
  computeResidualHomography,
  limitVisualResidual,
  multiplyHomographies
} from "./residualHomography";
import { applyMat3ToPixel } from "../geometry/displayTransform";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("residual homography", () => {
  it("computes H_visual = H_observed * inverse(H_sensor)", () => {
    const sensor: Mat3 = [1, 0, 0, 1, 1, 0, 10, 5, 1];
    const visual: Mat3 = [1, 0, 0, 0, 1, 0, 3, -2, 1];
    const observed = multiplyHomographies(visual, sensor);

    expect(computeResidualHomography(observed, sensor)).toEqual([
      expect.closeTo(1),
      expect.closeTo(0),
      expect.closeTo(0),
      expect.closeTo(0),
      expect.closeTo(1),
      expect.closeTo(0),
      expect.closeTo(3),
      expect.closeTo(-2),
      expect.closeTo(1)
    ]);
  });

  it("returns identity when observed and sensor motion agree", () => {
    const sensor: Mat3 = [0.99, 0.1, 0, -0.1, 0.99, 0, 12, -4, 1];
    expect(computeResidualHomography(sensor, sensor)).toEqual([
      expect.closeTo(1),
      expect.closeTo(0),
      expect.closeTo(0),
      expect.closeTo(0),
      expect.closeTo(1),
      expect.closeTo(0),
      expect.closeTo(0),
      expect.closeTo(0),
      expect.closeTo(1)
    ]);
  });

  it("normalizes by h33 and rejects singular or non-finite input", () => {
    expect(computeResidualHomography([2, 0, 0, 0, 2, 0, 6, -4, 2], IDENTITY)).toEqual([
      1, 0, 0, 0, 1, 0, 3, -2, 1
    ]);
    expect(() => computeResidualHomography(IDENTITY, [1, 0, 0, 0, 0, 0, 0, 0, 1])).toThrow(
      /singular/i
    );
    expect(() =>
      computeResidualHomography([1, 0, 0, 0, 1, 0, Number.NaN, 0, 1], IDENTITY)
    ).toThrow(/finite/i);
  });

  it("preserves a valid bounded projective correction at near and far image points", () => {
    const projective: Mat3 = [
      1.02, 0.01, 0.0001,
      0.02, 0.98, -0.00005,
      12, -8, 1
    ];
    const limited = limitVisualResidual(projective, {
      imageWidthPx: 1280,
      imageHeightPx: 720,
      maxPointDisplacementPx: 120,
      maxConditionNumber: 20
    });

    expect(limited).toEqual(projective.map((value) => expect.closeTo(value)));
    expect(applyMat3ToPixel(limited, { xPx: 160, yPx: 120 })).toEqual({
      xPx: expect.closeTo(175.841584, 5),
      yPx: expect.closeTo(110.09901, 5)
    });
    expect(applyMat3ToPixel(limited, { xPx: 1120, yPx: 600 })).toEqual({
      xPx: expect.closeTo(1078.003697, 5),
      yPx: expect.closeTo(546.395564, 5)
    });
    expect(limited[2]).not.toBe(0);
    expect(limited[5]).not.toBe(0);
  });

  it("rejects non-finite, near-singular, orientation-flipping, and ill-conditioned corrections", () => {
    const limits = {
      imageWidthPx: 1280,
      imageHeightPx: 720,
      maxPointDisplacementPx: 120,
      maxConditionNumber: 20
    };

    expect(() =>
      limitVisualResidual([1, 0, 0, 0, 1, 0, Number.NaN, 0, 1], limits)
    ).toThrow(/finite/i);
    expect(() =>
      limitVisualResidual([1, 0, 0, 0, 1e-12, 0, 0, 0, 1], limits)
    ).toThrow(/singular/i);
    expect(() =>
      limitVisualResidual([-1, 0, 0, 0, 1, 0, 0, 0, 1], limits)
    ).toThrow(/orientation/i);
    expect(() =>
      limitVisualResidual([50, 0, 0, 0, 0.02, 0, 0, 0, 1], limits)
    ).toThrow(/condition/i);
  });

  it("bounds full-image displacement without discarding scale, shear, or projective terms", () => {
    const raw: Mat3 = [
      1.1, 0.1, 0.0005,
      0.05, 0.95, -0.0003,
      300, -200, 1
    ];
    const limited = limitVisualResidual(raw, {
      imageWidthPx: 1280,
      imageHeightPx: 720,
      maxPointDisplacementPx: 80,
      maxConditionNumber: 20
    });
    const points = [
      { xPx: 0, yPx: 0 },
      { xPx: 1280, yPx: 0 },
      { xPx: 0, yPx: 720 },
      { xPx: 1280, yPx: 720 },
      { xPx: 640, yPx: 360 }
    ];

    for (const point of points) {
      const transformed = applyMat3ToPixel(limited, point);
      expect(Math.hypot(transformed.xPx - point.xPx, transformed.yPx - point.yPx))
        .toBeLessThanOrEqual(80.001);
    }
    expect(limited[0]).not.toBe(1);
    expect(limited[3]).not.toBe(0);
    expect(limited[2]).not.toBe(0);
    expect(limited[5]).not.toBe(0);
  });

  it("computes K delta-R K^-1 in full-image pixels", () => {
    const intrinsics = buildApproximateIntrinsics(1280, 720, 90);
    const quarterTurn: Mat3 = [
      0, 1, 0,
      -1, 0, 0,
      0, 0, 1
    ];

    const homography = buildSensorRotationHomography(
      IDENTITY,
      quarterTurn,
      intrinsics
    );

    expect(applyMat3ToPixel(homography, { xPx: 740, yPx: 360 })).toEqual({
      xPx: expect.closeTo(640),
      yPx: expect.closeTo(460)
    });
  });
});
