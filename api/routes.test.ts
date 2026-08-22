// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  ROUTES_FIELD_MASK,
  buildGoogleRequest,
  createClientRateLimiter,
  handleRouteRequest
} from "./routes";

const input = {
  origin: { lat: 22.5726, lng: 88.3639 },
  destination: {
    placeId: "destination-id",
    lat: 22.5826,
    lng: 88.3739
  }
};

const googleResponse = {
  routes: [
    {
      duration: "932s",
      distanceMeters: 1200,
      polyline: { encodedPolyline: "encoded-route" },
      legs: [
        {
          steps: [
            {
              distanceMeters: 200,
              polyline: { encodedPolyline: "encoded-step" },
              navigationInstruction: {
                maneuver: "TURN_LEFT",
                instructions: "Turn left"
              }
            }
          ]
        }
      ]
    }
  ]
};

describe("buildGoogleRequest", () => {
  it("maps app coordinates to Google latitude/longitude walking waypoints", () => {
    expect(buildGoogleRequest(input)).toEqual({
      origin: {
        location: {
          latLng: { latitude: 22.5726, longitude: 88.3639 }
        }
      },
      destination: {
        location: {
          latLng: { latitude: 22.5826, longitude: 88.3739 }
        }
      },
      travelMode: "WALK",
      polylineQuality: "HIGH_QUALITY"
    });
  });

  it("requests only the fields needed by navigation", () => {
    expect(ROUTES_FIELD_MASK).toBe(
      "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline," +
        "routes.legs.steps.distanceMeters,routes.legs.steps.polyline.encodedPolyline," +
        "routes.legs.steps.navigationInstruction"
    );
  });
});

describe("handleRouteRequest", () => {
  it("returns a normalized walking route without exposing the server key", async () => {
    const fetchGoogle = vi.fn<typeof fetch>(async () =>
      Response.json(googleResponse, { status: 200 })
    );
    const response = await handleRouteRequest(createRequest(input), {
      apiKey: "server-secret",
      fetch: fetchGoogle,
      log: vi.fn()
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      origin: input.origin,
      destination: { lat: 22.5826, lng: 88.3739 },
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
    });
    expect(fetchGoogle.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({
        "X-Goog-Api-Key": "server-secret",
        "X-Goog-FieldMask": ROUTES_FIELD_MASK
      })
    );
    expect(JSON.stringify(payload)).not.toContain("server-secret");
  });

  it("rejects invalid and oversized bodies before contacting Google", async () => {
    const fetchGoogle = vi.fn();
    const invalid = await handleRouteRequest(
      createRequest({ ...input, origin: { lat: 500, lng: 88 } }),
      { apiKey: "secret", fetch: fetchGoogle, log: vi.fn() }
    );
    const oversized = await handleRouteRequest(
      new Request("https://app.example/api/routes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example",
          "x-vercel-forwarded-for": "203.0.113.10"
        },
        body: JSON.stringify({ padding: "x".repeat(8200) })
      }),
      { apiKey: "secret", fetch: fetchGoogle, log: vi.fn() }
    );

    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(fetchGoogle).not.toHaveBeenCalled();
  });

  it("returns a safe error instead of the upstream response", async () => {
    const response = await handleRouteRequest(createRequest(input), {
      apiKey: "secret",
      fetch: vi.fn(async () => new Response("private upstream detail", { status: 500 })),
      log: vi.fn()
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      code: "ROUTES_UPSTREAM",
      message: "Google Routes could not calculate this walk."
    });
  });

  it("rejects a cross-origin browser request", async () => {
    const request = createRequest(input, "https://other.example");
    const response = await handleRouteRequest(request, {
      apiKey: "secret",
      fetch: vi.fn(),
      log: vi.fn()
    });

    expect(response.status).toBe(403);
  });

  it("rate limits a trusted hosting client without logging its IP", async () => {
    const fetchGoogle = vi.fn<typeof fetch>(async () =>
      Response.json(googleResponse, { status: 200 })
    );
    const log = vi.fn();
    const limiter = createClientRateLimiter({
      limit: 2,
      windowMs: 60_000,
      maxClients: 10
    });
    const dependencies = {
      apiKey: "secret",
      fetch: fetchGoogle,
      log,
      now: () => 1_000,
      rateLimiter: limiter
    };

    expect((await handleRouteRequest(createRequest(input), dependencies)).status).toBe(200);
    expect((await handleRouteRequest(createRequest(input), dependencies)).status).toBe(200);
    const limited = await handleRouteRequest(createRequest(input), dependencies);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(fetchGoogle).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("203.0.113.10");
  });

  it("rejects a missing or spoof-prone client address before routing", async () => {
    const fetchGoogle = vi.fn();
    const withoutHostingIp = createRequest(input);
    withoutHostingIp.headers.delete("x-vercel-forwarded-for");
    withoutHostingIp.headers.set("x-forwarded-for", "198.51.100.2");

    const response = await handleRouteRequest(withoutHostingIp, {
      apiKey: "secret",
      fetch: fetchGoogle,
      log: vi.fn(),
      rateLimiter: createClientRateLimiter()
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CLIENT_ID_REQUIRED" });
    expect(fetchGoogle).not.toHaveBeenCalled();
  });
});

function createRequest(body: unknown, origin = "https://app.example"): Request {
  return new Request("https://app.example/api/routes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "x-vercel-forwarded-for": "203.0.113.10"
    },
    body: JSON.stringify(body)
  });
}
