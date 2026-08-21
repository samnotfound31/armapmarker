import { describe, expect, it } from "vitest";
import { createRouteFrame, toEnu, toRouteLocal } from "./geo";

describe("local route geometry", () => {
  it("converts nearby longitude east and latitude north into metres", () => {
    const origin = { lat: 22.5726, lng: 88.3639 };
    const east = toEnu({ lat: origin.lat, lng: origin.lng + 0.0001 }, origin);
    const north = toEnu({ lat: origin.lat + 0.0001, lng: origin.lng }, origin);

    expect(east.eastMeters).toBeGreaterThan(10);
    expect(east.northMeters).toBeCloseTo(0, 1);
    expect(north.northMeters).toBeGreaterThan(11);
  });

  it("maps a northbound tangent to positive route-local forward", () => {
    const frame = createRouteFrame(
      { eastMeters: 0, northMeters: 0, upMeters: 0 },
      0
    );

    expect(
      toRouteLocal(
        {
          eastMeters: 0,
          northMeters: 10,
          upMeters: 0,
          routeDistanceMeters: 10
        },
        frame
      )
    ).toEqual({
      rightMeters: 0,
      upMeters: 0,
      forwardMeters: 10,
      routeDistanceMeters: 10
    });
  });

  it("preserves altitude relative to the ENU origin", () => {
    const result = toEnu(
      { lat: 10, lng: 20, altitudeMeters: 18 },
      { lat: 10, lng: 20, altitudeMeters: 12 }
    );

    expect(result.upMeters).toBe(6);
  });
});
