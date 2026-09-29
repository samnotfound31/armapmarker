import { describe, expect, it } from "vitest";
import { routeApiResponseSchema, routePlanSchema, routeRequestSchema } from "./routeSchemas";

describe("routeRequestSchema", () => {
  it("accepts a bounded origin and selected destination", () => {
    expect(
      routeRequestSchema.parse({
        origin: { lat: 22.5726, lng: 88.3639 },
        destination: {
          placeId: "ChIJ-valid-place-id",
          lat: 22.5826,
          lng: 88.3739
        }
      })
    ).toBeDefined();
  });

  it("rejects invalid coordinates and oversized identifiers", () => {
    expect(() =>
      routeRequestSchema.parse({
        origin: { lat: 999, lng: 88 },
        destination: { placeId: "x".repeat(513), lat: 22, lng: 88 }
      })
    ).toThrow();
  });
});

describe("routePlanSchema", () => {
  it("retains client-derived maneuver anchors without changing the API response contract", () => {
    const route = {
      origin: { lat: 0, lng: 0 },
      destination: { lat: 0.0001, lng: 0.0001, name: "Museum" },
      encodedPolyline: "??S?", distanceMeters: 20, durationSeconds: 20,
      steps: [{
        instruction: "Turn right", maneuver: "TURN_RIGHT", distanceMeters: 10,
        polyline: "S?S?", routeProgressMeters: 11.13
      }]
    };

    expect(routePlanSchema.parse(route).steps[0]?.routeProgressMeters).toBe(11.13);
    expect(() => routeApiResponseSchema.parse({
      ...route, destination: { lat: 0.0001, lng: 0.0001 }
    })).toThrow();
    expect(() => routePlanSchema.parse({
      ...route, steps: [{ ...route.steps[0]!, routeProgressMeters: -1 }]
    })).toThrow();
  });

  it("rejects a malformed route returned to the browser", () => {
    expect(() =>
      routePlanSchema.parse({
        origin: { lat: 22.57, lng: 88.36 },
        destination: { lat: 22.58, lng: 88.37, name: "Museum" },
        encodedPolyline: "abc",
        distanceMeters: -1,
        durationSeconds: 600,
        steps: []
      })
    ).toThrow();
  });
});
