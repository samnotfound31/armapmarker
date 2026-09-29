import { encode } from "@googlemaps/polyline-codec";
import { describe, expect, it } from "vitest";
import type { RoutePlan } from "../domain/types";
import { decodeAndSampleRoute, normalizeRouteGeometry } from "./polyline";

describe("decodeAndSampleRoute", () => {
  it("places samples every 2.5 metres and retains the destination", () => {
    const encoded = encode([
      [0, 0],
      [0, 0.0001]
    ]);

    const route = decodeAndSampleRoute(encoded, 2.5);

    expect(route.map((point) => point.routeDistanceMeters)).toEqual([
      0, 2.5, 5, 7.5, 10, expect.closeTo(11.1319, 3)
    ]);
    expect(route.at(-1)?.eastMeters).toBeCloseTo(11.1319, 3);
  });

  it("carries spacing across a turn instead of restarting per segment", () => {
    const encoded = encode([
      [0, 0],
      [0, 0.00003],
      [0.00003, 0.00003]
    ]);

    const route = decodeAndSampleRoute(encoded, 2.5);

    expect(route.map((point) => point.routeDistanceMeters)).toEqual([
      0, 2.5, expect.closeTo(3.3396, 3), 5, expect.closeTo(6.6792, 3)
    ]);
    expect(route[3]).toMatchObject({ eastMeters: expect.closeTo(3.3396, 3) });
    expect(route[3]?.northMeters).toBeGreaterThan(1.6);
  });

  it("retains a sharp original corner between regular samples", () => {
    const encoded = encode([
      [0, 0],
      [0.00003, 0],
      [0.00003, 0.00003]
    ]);

    const sampled = decodeAndSampleRoute(encoded, 2.5);
    const corner = sampled.find((point) =>
      Math.abs(point.routeDistanceMeters - 3.3395847) < 0.0001
    );

    expect(corner).toMatchObject({
      eastMeters: 0,
      northMeters: expect.closeTo(3.3395847, 5)
    });
    expect(sampled.map((point) => point.routeDistanceMeters)).toEqual([
      0, 2.5, expect.closeTo(3.3395847, 5), 5,
      expect.closeTo(6.6791694, 5)
    ]);
  });

  it("decodes every route point against an explicit shared ENU origin", () => {
    const encoded = encode([[0, 0.0001], [0, 0.0002]]);

    const route = decodeAndSampleRoute(encoded, 2.5, { lat: 0, lng: 0 });

    expect(route[0]?.eastMeters).toBeCloseTo(11.1319, 3);
    expect(route.at(-1)?.eastMeters).toBeCloseTo(22.2639, 3);
  });

  it("rejects invalid spacing and routes with fewer than two points", () => {
    expect(() => decodeAndSampleRoute(encode([[0, 0]]), 2.5)).toThrow(
      /at least two/i
    );
    expect(() => decodeAndSampleRoute(encode([[0, 0], [0, 0.0001]]), 0)).toThrow(
      /spacing/i
    );
  });
});

describe("normalizeRouteGeometry", () => {
  it("anchors the upcoming turn and route length to geometry despite provider step distances", () => {
    const points: [number, number][] = [
      [0, 0], [0.00018, 0], [0.00018, 0.00018]
    ];
    const normalized = normalizeRouteGeometry(plan(points, [
      {
        instruction: "Continue north", maneuver: "STRAIGHT",
        distanceMeters: 22, polyline: encode(points.slice(0, 2))
      },
      {
        instruction: "Turn right", maneuver: "TURN_RIGHT",
        distanceMeters: 18, polyline: encode(points.slice(1))
      }
    ]));

    expect(normalized.distanceMeters).toBeCloseTo(40.0750167, 5);
    expect(normalized.steps[0]?.routeProgressMeters).toBe(0);
    expect(normalized.steps[1]?.routeProgressMeters).toBeCloseTo(20.0375083, 5);
    expect(normalized.steps[1]?.distanceMeters).toBe(18);
    expect(normalized.durationSeconds).toBe(30);
  });

  it("anchors a repeated loop coordinate to the actual later occurrence", () => {
    const points: [number, number][] = [
      [0, 0], [0.0001, 0], [0.0001, 0.0001],
      [0, 0.0001], [0, 0], [-0.0001, 0]
    ];
    const normalized = normalizeRouteGeometry(plan(points, [
      {
        instruction: "Follow loop", maneuver: "STRAIGHT",
        distanceMeters: 42, polyline: encode(points.slice(0, 5))
      },
      {
        instruction: "Continue south", maneuver: "TURN_RIGHT",
        distanceMeters: 10, polyline: encode(points.slice(4))
      }
    ]));

    expect(normalized.steps[0]?.routeProgressMeters).toBe(0);
    expect(normalized.steps[1]?.routeProgressMeters).toBeCloseTo(44.5277963, 5);
    expect(normalized.distanceMeters).toBeCloseTo(55.6597454, 5);
  });

  it("does not invent a precise turn position from malformed step geometry", () => {
    const normalized = normalizeRouteGeometry(plan([[0, 0], [0.00018, 0]], [
      { instruction: "Turn right", maneuver: "TURN_RIGHT", distanceMeters: 20, polyline: "" }
    ]));

    expect(normalized.steps[0]?.routeProgressMeters).toBeUndefined();
    expect(normalized.distanceMeters).toBeCloseTo(20.0375083, 5);
  });
});

function plan(points: [number, number][], steps: RoutePlan["steps"]): RoutePlan {
  return {
    origin: { lat: points[0]![0], lng: points[0]![1] },
    destination: { lat: points.at(-1)![0], lng: points.at(-1)![1], name: "Destination" },
    encodedPolyline: encode(points), distanceMeters: 40, durationSeconds: 30, steps
  };
}
