import { encode } from "@googlemaps/polyline-codec";
import { describe, expect, it } from "vitest";
import type { RoutePlan } from "../domain/types";
import type { LocationFix } from "../device/location";
import { prepareRoute } from "./prepareRoute";

describe("prepareRoute", () => {
  it.each([
    {
      name: "eastbound",
      points: [[0, 0], [0, 0.0002]],
      expectedEnd: { rightMeters: 0, forwardMeters: 22.26 }
    },
    {
      name: "westbound",
      points: [[0, 0], [0, -0.0002]],
      expectedEnd: { rightMeters: 0, forwardMeters: 22.26 }
    },
    {
      name: "northbound",
      points: [[0, 0], [0.0002, 0]],
      expectedEnd: { rightMeters: 0, forwardMeters: 22.26 }
    }
  ])("maps a $name route tangent to route-local forward", ({ points, expectedEnd }) => {
    const prepared = prepareRoute(route(points), fix(points[0]!));

    expect(prepared.calibrationProgressMeters).toBeCloseTo(0);
    expect(prepared.calibrationRoutePoint).toMatchObject({
      rightMeters: expect.closeTo(0),
      forwardMeters: expect.closeTo(0)
    });
    expect(prepared.groundRoute.at(-1)).toMatchObject({
      rightMeters: expect.closeTo(expectedEnd.rightMeters, 1),
      forwardMeters: expect.closeTo(expectedEnd.forwardMeters, 1)
    });
  });

  it("keeps curve geometry after fitting the tangent at the calibration match", () => {
    const prepared = prepareRoute(
      route([[0, 0], [0, 0.0001], [0.0001, 0.0001]]),
      fix([0, 0])
    );

    expect(prepared.groundRoute.at(-1)).toMatchObject({
      rightMeters: expect.closeTo(-11.13, 1),
      forwardMeters: expect.closeTo(11.13, 1)
    });
  });

  it("uses the route origin for both decoded geometry and the calibration fix", () => {
    const plan = route([[0, 0.0001], [0, 0.0002]]);
    plan.origin = { lat: 0, lng: 0 };

    const prepared = prepareRoute(plan, fix([0, 0.0001]));

    expect(prepared.enuOrigin).toEqual(plan.origin);
    expect(prepared.localRoute[0]?.eastMeters).toBeCloseTo(11.13, 1);
    expect(prepared.calibrationProgressMeters).toBeCloseTo(0);
  });

  it("preserves actual lateral location separately from matched progress", () => {
    const prepared = prepareRoute(
      route([[0, 0], [0.0003, 0]]),
      fix([0.0001, 0.00009])
    );

    expect(prepared.calibrationProgressMeters).toBeCloseTo(11.1319491, 5);
    expect(prepared.calibrationRoutePoint.rightMeters).toBeCloseTo(0);
    expect(prepared.initialActualPositionRoute).toMatchObject({
      rightMeters: expect.closeTo(10.0187542, 5),
      forwardMeters: expect.closeTo(0, 5)
    });
    expect(prepared.routeBearingRad).toBeCloseTo(0);
    expect(prepared.routeFrame.tangentBearingRad).toBeCloseTo(0);
    expect(prepared.normalizedRoute.distanceMeters).toBeCloseTo(33.3958472, 5);
  });

  it("exposes the geographic initial route bearing independently of the camera", () => {
    const prepared = prepareRoute(route([[0, 0], [0, 0.0002]]), fix([0, 0]));

    expect(prepared.routeBearingRad).toBeCloseTo(Math.PI / 2);
  });

  it("keeps a realignment on the previous leg when a parallel return leg is slightly closer", () => {
    const plan = route([
      [0, 0], [0.0009, 0], [0.0009, 0.00004], [0, 0.00004]
    ]);

    const prepared = prepareRoute(plan, fix([0.00027, 0.000021]), 30);

    expect(prepared.calibrationProgressMeters).toBeCloseTo(30.0562625, 4);
    expect(prepared.routeBearingRad).toBeCloseTo(0);
    expect(prepared.initialActualPositionRoute.rightMeters).toBeCloseTo(2.3377093, 5);
    expect(prepared.initialMatchUncertain).toBe(false);
  });

  it("preserves prior progress when re-alignment has no plausible nearby match", () => {
    const prepared = prepareRoute(
      route([[0, 0], [0.001, 0]]),
      fix([0.001, 0.001]),
      30
    );

    expect(prepared.calibrationProgressMeters).toBe(30);
    expect(prepared.initialMatchUncertain).toBe(true);
    expect(prepared.initialActualPositionRoute.rightMeters).toBeCloseTo(111.3194908, 5);
  });

  it("marks initial topologically distant parallel legs as geographically ambiguous", () => {
    const prepared = prepareRoute(
      route([[0, 0], [0.0009, 0], [0.0009, 0.00004], [0, 0.00004]]),
      fix([0.00027, 0.00002])
    );

    expect(prepared.initialMatchUncertain).toBe(true);
  });
});

function route(points: number[][]): RoutePlan {
  const first = points[0]!;
  const last = points.at(-1)!;
  return {
    origin: { lat: first[0]!, lng: first[1]! },
    destination: { lat: last[0]!, lng: last[1]!, name: "Destination" },
    encodedPolyline: encode(points as [number, number][]),
    distanceMeters: 100,
    durationSeconds: 80,
    steps: []
  };
}

function fix(point: number[]): LocationFix {
  return {
    point: { lat: point[0]!, lng: point[1]! },
    accuracyMeters: 5,
    timestampMs: 1000
  };
}
