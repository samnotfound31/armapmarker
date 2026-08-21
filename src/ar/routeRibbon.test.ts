import { describe, expect, it } from "vitest";
import type { RouteGroundPoint } from "../domain/types";
import { buildRouteRibbon } from "./routeRibbon";

const STRAIGHT = [point(0, 0, 0), point(0, 20, 20), point(0, 40, 40)];
const CURVE = [point(0, 0, 0), point(0, 20, 20), point(20, 20, 40)];

describe("buildRouteRibbon", () => {
  it("samples only the interval ahead of progress up to the draw limit", () => {
    const ribbon = buildRouteRibbon(STRAIGHT, 5, {
      markerSpacingMeters: 5,
      startAheadMeters: 1,
      maximumDrawDistanceMeters: 15,
      markerWidthMeters: 1.4
    });

    expect(ribbon.markers.map((marker) => marker.routeDistanceMeters)).toEqual([
      6, 11, 16
    ]);
    expect(ribbon.markers.every((marker) => marker.routeDistanceMeters > 5)).toBe(true);
    expect(ribbon.drawEndRouteDistanceMeters).toBe(20);
  });

  it("alternates arrows and bars at a stable vertex count on straight and curved roads", () => {
    const options = {
      markerSpacingMeters: 5,
      startAheadMeters: 1,
      maximumDrawDistanceMeters: 15,
      markerWidthMeters: 1.4
    };
    const straight = buildRouteRibbon(STRAIGHT, 5, options);
    const curve = buildRouteRibbon(CURVE, 5, options);

    expect(straight.markers.map((marker) => marker.kind)).toEqual([
      "arrow",
      "bar",
      "arrow"
    ]);
    expect(curve.positions.length).toBe(straight.positions.length);
    expect(curve.indices.length).toBe(straight.indices.length);
  });

  it("preserves physical width and emphasizes a marker near a turn", () => {
    const ribbon = buildRouteRibbon(CURVE, 5, {
      markerSpacingMeters: 5,
      startAheadMeters: 1,
      maximumDrawDistanceMeters: 15,
      markerWidthMeters: 1.4
    });
    const first = ribbon.markers[0]!;
    const turnMarker = ribbon.markers[2]!;

    expect(first.widthMeters).toBeCloseTo(1.4);
    expect(turnMarker.emphasized).toBe(true);
    expect(turnMarker.widthMeters).toBeCloseTo(1.75);
  });

  it("clips every marker when the route is behind the displayed progress", () => {
    const ribbon = buildRouteRibbon(STRAIGHT, 45);
    expect(ribbon.markers).toHaveLength(0);
    expect(ribbon.positions).toHaveLength(0);
    expect(ribbon.indices).toHaveLength(0);
  });
});

function point(
  rightMeters: number,
  forwardMeters: number,
  routeDistanceMeters: number
): RouteGroundPoint {
  return { rightMeters, upMeters: 0, forwardMeters, routeDistanceMeters };
}
