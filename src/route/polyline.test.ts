import { encode } from "@googlemaps/polyline-codec";
import { describe, expect, it } from "vitest";
import { decodeAndSampleRoute } from "./polyline";

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
      0, 2.5, 5, expect.closeTo(6.6792, 3)
    ]);
    expect(route[2]).toMatchObject({ eastMeters: expect.closeTo(3.3396, 3) });
    expect(route[2]?.northMeters).toBeGreaterThan(1.6);
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
