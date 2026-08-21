// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  ROUTES_FIELD_MASK,
  buildGoogleRequest,
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
          Origin: "https://app.example"
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
});

function createRequest(body: unknown, origin = "https://app.example"): Request {
  return new Request("https://app.example/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body)
  });
}
