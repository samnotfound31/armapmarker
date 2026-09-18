// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { handleSearchRequest } from "./search";

const searchInput = {
  query: "City Museum",
  origin: { lat: 22.5726, lng: 88.3639 }
};

const peliasResponse = {
  geocoding: {
    version: "0.2",
    attribution: "https://openstreetmap.org/copyright",
    query: { text: "City Museum", size: 5 },
    engine: { name: "Pelias", author: "Mapzen", version: "1.0" },
    timestamp: 1
  },
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [88.3739, 22.5826] },
      properties: {
        id: "node:123",
        gid: "openstreetmap:venue:node:123",
        layer: "venue",
        source: "openstreetmap",
        source_id: "node:123",
        name: "City Museum",
        confidence: 0.91,
        distance: 1.4,
        accuracy: "point",
        country: "India",
        country_gid: "whosonfirst:country:85632469",
        region: "West Bengal",
        locality: "Kolkata",
        label: "City Museum, Kolkata, West Bengal, India"
      }
    }
  ],
  bbox: [88.3739, 22.5826, 88.3739, 22.5826]
};

describe("handleSearchRequest", () => {
  it("normalizes Pelias autocomplete results without exposing the key", async () => {
    const fetchHeiGit = vi.fn<typeof fetch>(async () =>
      Response.json(peliasResponse)
    );
    const response = await handleSearchRequest(createRequest(searchInput), {
      apiKey: "server-secret",
      fetch: fetchHeiGit,
      log: vi.fn()
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      suggestions: [
        {
          placeId: "openstreetmap:venue:node:123",
          name: "City Museum",
          formattedAddress: "City Museum, Kolkata, West Bengal, India",
          location: { lat: 22.5826, lng: 88.3739 }
        }
      ]
    });
    const [requestUrl, requestInit] = fetchHeiGit.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.heigit.org/pelias/v1/autocomplete"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: "City Museum",
      size: "5",
      lang: "en",
      "focus.point.lat": "22.5726",
      "focus.point.lon": "88.3639"
    });
    expect(requestInit).toMatchObject({
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "server-secret"
      }
    });
    expect(JSON.stringify(payload)).not.toContain("server-secret");
  });

  it("returns an empty suggestion list when Pelias finds nothing", async () => {
    const response = await handleSearchRequest(createRequest(searchInput), {
      apiKey: "secret",
      fetch: vi.fn(async () =>
        Response.json({ ...peliasResponse, features: [], bbox: undefined })
      ),
      log: vi.fn()
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
  });

  it("rejects malformed Pelias results rather than returning partial places", async () => {
    const malformed = structuredClone(peliasResponse);
    malformed.features[0]!.geometry.coordinates = [22.5826, 500];
    const response = await handleSearchRequest(createRequest(searchInput), {
      apiKey: "secret",
      fetch: vi.fn(async () => Response.json(malformed)),
      log: vi.fn()
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      code: "SEARCH_RESPONSE",
      message: "The destination provider returned invalid results."
    });
  });

  it("translates provider rate limits and outages to safe errors", async () => {
    const rateLimited = await handleSearchRequest(createRequest(searchInput), {
      apiKey: "secret",
      fetch: vi.fn(async () =>
        new Response("private", {
          status: 429,
          headers: { "Retry-After": "23" }
        })
      ),
      log: vi.fn()
    });
    const unavailable = await handleSearchRequest(createRequest(searchInput), {
      apiKey: "secret",
      fetch: vi.fn(async () => new Response("private", { status: 503 })),
      log: vi.fn()
    });

    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("Retry-After")).toBe("23");
    expect(await rateLimited.json()).toMatchObject({ code: "SEARCH_RATE_LIMITED" });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "SEARCH_UNAVAILABLE" });
  });

  it("aborts a stalled provider before the serverless deadline", async () => {
    vi.useFakeTimers();
    const fetchHeiGit = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      })
    );
    const pending = handleSearchRequest(createRequest(searchInput), {
      apiKey: "secret",
      fetch: fetchHeiGit,
      log: vi.fn()
    });

    await vi.advanceTimersByTimeAsync(8_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SEARCH_UNAVAILABLE" });
    expect(fetchHeiGit.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("validates same-origin input before contacting the provider", async () => {
    const fetchHeiGit = vi.fn();
    const tooShort = await handleSearchRequest(
      createRequest({ query: "x" }),
      { apiKey: "secret", fetch: fetchHeiGit, log: vi.fn() }
    );
    const crossOrigin = await handleSearchRequest(
      createRequest(searchInput, "https://other.example"),
      { apiKey: "secret", fetch: fetchHeiGit, log: vi.fn() }
    );

    expect(tooShort.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
    expect(fetchHeiGit).not.toHaveBeenCalled();
  });
});

function createRequest(body: unknown, origin = "https://app.example"): Request {
  return new Request("https://app.example/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "x-vercel-forwarded-for": "203.0.113.10"
    },
    body: JSON.stringify(body)
  });
}
