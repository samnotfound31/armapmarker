import { describe, expect, it } from "vitest";
import type { Mat3 } from "../domain/types";
import {
  computeResidualHomography,
  limitVisualResidual,
  multiplyHomographies
} from "./residualHomography";

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

  it("caps image correction while preserving unit metric scale", () => {
    const raw: Mat3 = [1.29, 0.55, 0.002, -0.55, 1.29, -0.001, 200, -150, 1];
    const limited = limitVisualResidual(raw, {
      maxRotationRad: 0.1,
      maxTranslationPx: 40
    });

    expect(Math.hypot(limited[0], limited[1])).toBeCloseTo(1);
    expect(Math.atan2(limited[1], limited[0])).toBeCloseTo(0.1);
    expect(Math.hypot(limited[6], limited[7])).toBeCloseTo(40);
    expect(limited[2]).toBe(0);
    expect(limited[5]).toBe(0);
    expect(limited[8]).toBe(1);
  });
});
