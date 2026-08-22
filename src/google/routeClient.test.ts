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
  encodedPolyline: "encoded-route",
  distanceMeters: 1200,
  durationSeconds: 932,
  steps: [
    {
      instruction: "Turn left",
      maneuver: "TURN_LEFT",
      distanceMeters: 200,
      polyline: "encoded-step"
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
});
