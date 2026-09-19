// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  buildHeiGitRouteRequest,
  createClientRateLimiter,
  handleRouteRequest,
  mapOrsManeuver
} from "./routes";

const input = {
  origin: { lat: 22.5726, lng: 88.3639 },
  destination: {
    placeId: "openstreetmap:venue:destination-id",
    lat: 22.5826,
    lng: 88.3739
  }
};

const orsResponse = {
  type: "FeatureCollection",
  bbox: [88.3639, 22.5726, 88.3739, 22.5826],
  features: [
    {
      type: "Feature",
      bbox: [88.3639, 22.5726, 88.3739, 22.5826],
      properties: {
        summary: { distance: 1200, duration: 932.4 },
        segments: [
          {
            distance: 1200,
            duration: 932.4,
            steps: [
              {
                distance: 600,
                duration: 470,
                type: 6,
                instruction: "Continue straight",
                name: "Museum Road",
                way_points: [0, 1]
              },
              {
                distance: 600,
                duration: 462.4,
                type: 0,
                instruction: "Turn left onto Gallery Street",
                name: "Gallery Street",
                way_points: [1, 2]
              }
            ]
          }
        ],
        way_points: [0, 2]
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [88.3639, 22.5726],
          [88.3689, 22.5776],
          [88.3739, 22.5826]
        ]
      }
    }
  ],
  metadata: {
    attribution: "openrouteservice.org | OpenStreetMap contributors",
    service: "routing",
    timestamp: 1
  }
};

describe("buildHeiGitRouteRequest", () => {
  it("maps app coordinates to ORS longitude/latitude walking input", () => {
    expect(buildHeiGitRouteRequest(input)).toEqual({
      coordinates: [
        [88.3639, 22.5726],
        [88.3739, 22.5826]
      ],
      instructions: true,
      language: "en"
    });
  });
});

describe("mapOrsManeuver", () => {
  it.each([
    [0, "TURN_LEFT"],
    [1, "TURN_RIGHT"],
    [2, "TURN_SHARP_LEFT"],
    [3, "TURN_SHARP_RIGHT"],
    [4, "TURN_SLIGHT_LEFT"],
    [5, "TURN_SLIGHT_RIGHT"],
    [6, "STRAIGHT"],
    [7, "ROUNDABOUT_ENTER"],
    [8, "ROUNDABOUT_EXIT"],
    [9, "UTURN"],
    [10, "ARRIVE"],
    [11, "DEPART"],
    [12, "KEEP_LEFT"],
    [13, "KEEP_RIGHT"],
    [99, "STRAIGHT"]
  ])("maps ORS instruction type %i to %s", (type, expected) => {
    expect(mapOrsManeuver(type)).toBe(expected);
  });
});

describe("handleRouteRequest", () => {
  it("loads emitted search and route handlers in native Node ESM", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const output = mkdtempSync(path.join(tmpdir(), "ar-api-esm-"));
    try {
      const program = ts.createProgram(
        [path.join(root, "api/search.ts"), path.join(root, "api/routes.ts")],
        {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          esModuleInterop: true,
          skipLibCheck: true,
          rootDir: root,
          outDir: output,
          types: []
        }
      );
      expect(program.emit().emitSkipped).toBe(false);
      writeFileSync(path.join(output, "package.json"), '{"type":"module"}');
      symlinkSync(path.join(root, "node_modules"), path.join(output, "node_modules"), "dir");
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { readFileSync } from "node:fs";
        const { handleRouteRequest } = await import("./api/routes.js");
        const { handleSearchRequest } = await import("./api/search.js");
        const { input, provider } = JSON.parse(readFileSync(0, "utf8"));
        const response = await handleRouteRequest(new Request("https://app.example/api/routes", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": "203.0.113.10" },
          body: JSON.stringify(input)
        }), { apiKey: "test-secret", fetch: async () => Response.json(provider), log: () => {} });
        const search = await handleSearchRequest(new Request("https://app.example/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": "203.0.113.10" },
          body: JSON.stringify({ query: "Heidelberg" })
        }), {
          apiKey: "test-secret",
          fetch: async () => Response.json({ type: "FeatureCollection", features: [] }),
          log: () => {}
        });
        console.log(JSON.stringify({ status: response.status, payload: await response.json(), searchStatus: search.status }));
      `], { cwd: output, input: JSON.stringify({ input, provider: orsResponse }), encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        searchStatus: 200,
        status: 200,
        payload: {
          encodedPolyline: "wuwhCkqizOg^g^g^g^",
          distanceMeters: 1200,
          durationSeconds: 932,
          steps: [
            { maneuver: "STRAIGHT", polyline: "wuwhCkqizOg^g^" },
            { maneuver: "TURN_LEFT", polyline: "_uxhCspjzOg^g^" }
          ]
        }
      });
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 15_000);

  it("normalizes ORS GeoJSON into the existing RoutePlan boundary", async () => {
    const fetchHeiGit = vi.fn<typeof fetch>(async () =>
      Response.json(orsResponse, { status: 200 })
    );
    const response = await handleRouteRequest(createRequest(input), {
      apiKey: "server-secret",
      fetch: fetchHeiGit,
      log: vi.fn()
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      origin: input.origin,
      destination: { lat: 22.5826, lng: 88.3739 },
      encodedPolyline: "wuwhCkqizOg^g^g^g^",
      distanceMeters: 1200,
      durationSeconds: 932,
      steps: [
        {
          instruction: "Continue straight",
          maneuver: "STRAIGHT",
          distanceMeters: 600,
          polyline: "wuwhCkqizOg^g^"
        },
        {
          instruction: "Turn left onto Gallery Street",
          maneuver: "TURN_LEFT",
          distanceMeters: 600,
          polyline: "_uxhCspjzOg^g^"
        }
      ]
    });
    expect(fetchHeiGit).toHaveBeenCalledWith(
      "https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/geo+json",
          Authorization: "server-secret",
          "Content-Type": "application/json"
        }
      })
    );
    expect(JSON.stringify(payload)).not.toContain("server-secret");
  });

  it("rejects malformed ORS geometry instead of returning a partial route", async () => {
    const malformed = structuredClone(orsResponse);
    malformed.features[0]!.geometry.coordinates = [[88.3639, 22.5726]];
    const response = await handleRouteRequest(createRequest(input), {
      apiKey: "secret",
      fetch: vi.fn(async () => Response.json(malformed)),
      log: vi.fn()
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      code: "ROUTES_RESPONSE",
      message: "The walking route provider returned an invalid route."
    });
  });

  it("translates an upstream rate limit without leaking its response", async () => {
    const response = await handleRouteRequest(createRequest(input), {
      apiKey: "secret",
      fetch: vi.fn(async () =>
        new Response("private provider detail", {
          status: 429,
          headers: { "Retry-After": "17" }
        })
      ),
      log: vi.fn()
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(await response.json()).toEqual({
      code: "ROUTES_RATE_LIMITED",
      message: "The walking route service is busy. Try again shortly."
    });
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
    const pending = handleRouteRequest(createRequest(input), {
      apiKey: "secret",
      fetch: fetchHeiGit,
      log: vi.fn()
    });

    await vi.advanceTimersByTimeAsync(8_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ROUTES_UNAVAILABLE" });
    expect(fetchHeiGit.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("rejects invalid and oversized bodies before contacting the provider", async () => {
    const fetchHeiGit = vi.fn();
    const invalid = await handleRouteRequest(
      createRequest({ ...input, origin: { lat: 500, lng: 88 } }),
      { apiKey: "secret", fetch: fetchHeiGit, log: vi.fn() }
    );
    const oversized = await handleRouteRequest(
      new Request("https://app.example/api/routes", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ padding: "x".repeat(8200) })
      }),
      { apiKey: "secret", fetch: fetchHeiGit, log: vi.fn() }
    );

    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(fetchHeiGit).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin browser request", async () => {
    const response = await handleRouteRequest(
      createRequest(input, "https://other.example"),
      { apiKey: "secret", fetch: vi.fn(), log: vi.fn() }
    );

    expect(response.status).toBe(403);
  });

  it("rate limits a trusted hosting client without logging its IP", async () => {
    const fetchHeiGit = vi.fn<typeof fetch>(async () => Response.json(orsResponse));
    const log = vi.fn();
    const limiter = createClientRateLimiter({
      limit: 2,
      windowMs: 60_000,
      maxClients: 10
    });
    const dependencies = {
      apiKey: "secret",
      fetch: fetchHeiGit,
      log,
      now: () => 1_000,
      rateLimiter: limiter
    };

    expect((await handleRouteRequest(createRequest(input), dependencies)).status).toBe(200);
    expect((await handleRouteRequest(createRequest(input), dependencies)).status).toBe(200);
    const limited = await handleRouteRequest(createRequest(input), dependencies);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(fetchHeiGit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("203.0.113.10");
  });

  it("rejects a missing or spoof-prone client address before routing", async () => {
    const request = createRequest(input);
    request.headers.delete("x-vercel-forwarded-for");
    request.headers.set("x-forwarded-for", "198.51.100.2");
    const fetchHeiGit = vi.fn();
    const response = await handleRouteRequest(request, {
      apiKey: "secret",
      fetch: fetchHeiGit,
      log: vi.fn(),
      rateLimiter: createClientRateLimiter()
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CLIENT_ID_REQUIRED" });
    expect(fetchHeiGit).not.toHaveBeenCalled();
  });
});

function requestHeaders(origin = "https://app.example") {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    "x-vercel-forwarded-for": "203.0.113.10"
  };
}

function createRequest(body: unknown, origin = "https://app.example"): Request {
  return new Request("https://app.example/api/routes", {
    method: "POST",
    headers: requestHeaders(origin),
    body: JSON.stringify(body)
  });
}
