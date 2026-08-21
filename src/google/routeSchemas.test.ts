import { describe, expect, it } from "vitest";
import { routePlanSchema, routeRequestSchema } from "./routeSchemas";

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
