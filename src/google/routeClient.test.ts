import { encode } from "@googlemaps/polyline-codec";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "../domain/types";
import { requestWalkingRoute } from "./routeClient";

const destination: Destination = {
  placeId: "museum-place-id",
  name: "City Museum",
  formattedAddress: "1 Museum Road",
  location: { lat: 22.58, lng: 88.37 }
};

const apiRoute = {
  origin: { lat: 22.57, lng: 88.36 },
  destination: { lat: 22.58, lng: 88.37 },
  encodedPolyline: encode([[22.57, 88.36], [22.58, 88.37]]),
  distanceMeters: 1200,
  durationSeconds: 932,
  steps: [
    {
      instruction: "Turn left",
      maneuver: "TURN_LEFT",
      distanceMeters: 200,
      polyline: encode([[22.57, 88.36], [22.58, 88.37]])
    }
  ]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestWalkingRoute", () => {
  it("passes cancellation to the route boundary and restores the place name", async () => {
    const controller = new AbortController();
    const fetchRoute = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(apiRoute), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchRoute);

    const route = await requestWalkingRoute(
      { origin: apiRoute.origin, destination },
      controller.signal
    );

    expect(route.destination).toEqual({
      lat: 22.58,
      lng: 88.37,
      name: "City Museum",
      placeId: "museum-place-id"
    });
    expect(fetchRoute).toHaveBeenCalledOnce();
    expect(fetchRoute.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      signal: controller.signal
    });
  });

  it("surfaces a safe retryable route error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: "ROUTES_UPSTREAM", message: "Route unavailable" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      requestWalkingRoute(
        { origin: apiRoute.origin, destination },
        new AbortController().signal
      )
    ).rejects.toEqual(
      expect.objectContaining({
        name: "RouteClientError",
        code: "ROUTES_UPSTREAM",
        message: "Route unavailable",
        status: 503,
        retryable: true
      })
    );
  });

  it("returns maneuver anchors on the same geometry distance reference as navigation", async () => {
    const points: [number, number][] = [[0, 0], [0.00018, 0], [0.00018, 0.00018]];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      origin: { lat: 0, lng: 0 },
      destination: { lat: 0.00018, lng: 0.00018 },
      encodedPolyline: encode(points), distanceMeters: 45, durationSeconds: 30,
      steps: [
        {
          instruction: "Continue", maneuver: "STRAIGHT", distanceMeters: 23,
          polyline: encode(points.slice(0, 2))
        },
        {
          instruction: "Turn right", maneuver: "TURN_RIGHT", distanceMeters: 22,
          polyline: encode(points.slice(1))
        }
      ]
    }), { status: 200 })));

    const route = await requestWalkingRoute({
      origin: { lat: 0, lng: 0 },
      destination: { ...destination, location: { lat: 0.00018, lng: 0.00018 } }
    }, new AbortController().signal);

    expect(route.distanceMeters).toBeCloseTo(40.0750167, 5);
    expect(route.steps[1]?.routeProgressMeters).toBeCloseTo(20.0375083, 5);
  });
});
