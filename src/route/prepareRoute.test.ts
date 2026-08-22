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
