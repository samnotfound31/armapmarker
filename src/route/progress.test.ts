import { describe, expect, it } from "vitest";
import type { LocalRoutePoint } from "../domain/types";
import {
  ProgressSmoother,
  hasArrived,
  isOffRoute,
  nearestRouteProgress
} from "./progress";

const point = (
  eastMeters: number,
  northMeters: number,
  routeDistanceMeters: number
): LocalRoutePoint => ({
  eastMeters,
  northMeters,
  upMeters: 0,
  routeDistanceMeters
});

describe("nearestRouteProgress", () => {
  it("interpolates progress and the nearest point inside a segment", () => {
    const match = nearestRouteProgress(point(4, 3, 0), [
      point(0, 0, 0),
      point(10, 0, 10)
    ]);

    expect(match).toEqual({
      progressMeters: 4,
      crossTrackDistanceMeters: 3,
      nearestPoint: point(4, 0, 4),
      segmentIndex: 0
    });
  });

  it("rejects a route without a segment", () => {
    expect(() => nearestRouteProgress(point(0, 0, 0), [point(0, 0, 0)])).toThrow(
      /two route points/i
    );
  });
});

describe("ProgressSmoother", () => {
  it("does not exceed the walking-speed and GPS-accuracy bound", () => {
    const smoother = new ProgressSmoother(0);

    const next = smoother.update(100, 0.1, 5);

    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(0.75);
  });

  it("converges smoothly to a stable nearby target", () => {
    const smoother = new ProgressSmoother(0);
    let value = 0;

    for (let frame = 0; frame < 100; frame += 1) {
      value = smoother.update(2, 0.1, 0);
    }

    expect(value).toBeCloseTo(2, 2);
  });

  it("ignores an invalid time step", () => {
    const smoother = new ProgressSmoother(7);
    expect(smoother.update(20, 0, 3)).toBe(7);
  });
});

describe("route status decisions", () => {
  const outside = { crossTrackDistanceMeters: 21, accuracyMeters: 10 };

  it("requires three consecutive accurate off-route readings", () => {
    expect(isOffRoute([outside, outside])).toBe(false);
    expect(isOffRoute([outside, outside, outside])).toBe(true);
    expect(
      isOffRoute([
        outside,
        { crossTrackDistanceMeters: 25, accuracyMeters: 16 },
        outside
      ])
    ).toBe(false);
  });

  it("requires route progress and destination proximity for arrival", () => {
    expect(hasArrived(96, 100, 21)).toBe(false);
    expect(hasArrived(94, 100, 10)).toBe(false);
    expect(hasArrived(95, 100, 20)).toBe(true);
  });
});
