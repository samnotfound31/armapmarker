import polylineCodec from "@googlemaps/polyline-codec";
import { z } from "zod";
import {
  routeApiResponseSchema,
  routeRequestSchema,
  type RouteRequestInput
} from "../src/google/routeSchemas.js";
import { createHeiGitHeaders, HEIGIT_ENDPOINTS } from "./providers/heigitConfig.js";
import {
  createUpstreamRequestSignal,
  safeRetryAfter
} from "./providers/upstreamRequest.js";
import {
  createClientRateLimiter,
  trustedClientId,
  type ClientRateLimiter
} from "./requestPolicy.js";

export { createClientRateLimiter } from "./requestPolicy.js";

const MAX_BODY_BYTES = 8 * 1024;
const longitudeSchema = z.number().finite().min(-180).max(180);
const latitudeSchema = z.number().finite().min(-90).max(90);
const coordinateSchema = z.tuple([longitudeSchema, latitudeSchema]);
const orsStepSchema = z.object({
  distance: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  type: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1),
  name: z.string(),
  way_points: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative()
  ])
});
const orsResponseSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z
    .array(
      z.object({
        type: z.literal("Feature"),
        properties: z.object({
          summary: z.object({
            distance: z.number().finite().nonnegative(),
            duration: z.number().finite().nonnegative()
          }),
          segments: z.array(
            z.object({
              distance: z.number().finite().nonnegative(),
              duration: z.number().finite().nonnegative(),
              steps: z.array(orsStepSchema)
            })
          )
        }),
        geometry: z.object({
          type: z.literal("LineString"),
          coordinates: z.array(coordinateSchema).min(2)
        })
      })
    )
    .min(1)
});

type HandlerDependencies = {
  apiKey?: string;
  fetch: typeof fetch;
  log: (event: {
    status: number;
    latencyMs: number;
    category: string;
  }) => void;
  now?: () => number;
  rateLimiter?: ClientRateLimiter;
};

const defaultRateLimiter = createClientRateLimiter();

export function buildHeiGitRouteRequest(input: RouteRequestInput) {
  return {
    coordinates: [
      [input.origin.lng, input.origin.lat],
      [input.destination.lng, input.destination.lat]
    ],
    instructions: true,
    language: "en"
  } as const;
}

const ORS_MANEUVERS: Readonly<Record<number, string>> = {
  0: "TURN_LEFT",
  1: "TURN_RIGHT",
  2: "TURN_SHARP_LEFT",
  3: "TURN_SHARP_RIGHT",
  4: "TURN_SLIGHT_LEFT",
  5: "TURN_SLIGHT_RIGHT",
  6: "STRAIGHT",
  7: "ROUNDABOUT_ENTER",
  8: "ROUNDABOUT_EXIT",
  9: "UTURN",
  10: "ARRIVE",
  11: "DEPART",
  12: "KEEP_LEFT",
  13: "KEEP_RIGHT"
};

export function mapOrsManeuver(type: number): string {
  return ORS_MANEUVERS[type] ?? "STRAIGHT";
}

export async function handleRouteRequest(
  request: Request,
  dependencies: HandlerDependencies
): Promise<Response> {
  const startedAt = (dependencies.now ?? Date.now)();
  const requestOrigin = new URL(request.url).origin;
  const browserOrigin = request.headers.get("Origin");
  const respond = (
    body: unknown,
    status: number,
    category: string,
    extraHeaders: Record<string, string> = {}
  ): Response => {
    dependencies.log({
      status,
      category,
      latencyMs: (dependencies.now ?? Date.now)() - startedAt
    });
    return Response.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Origin",
        ...extraHeaders,
        ...(browserOrigin === requestOrigin
          ? { "Access-Control-Allow-Origin": requestOrigin }
          : {})
      }
    });
  };

  if (browserOrigin && browserOrigin !== requestOrigin) {
    return respond(
      { code: "CROSS_ORIGIN", message: "Cross-origin route requests are blocked." },
      403,
      "cross_origin"
    );
  }
  if (request.method !== "POST") {
    return respond(
      { code: "METHOD_NOT_ALLOWED", message: "Use POST for route requests." },
      405,
      "method"
    );
  }

  const clientId = trustedClientId(request);
  if (!clientId) {
    return respond(
      {
        code: "CLIENT_ID_REQUIRED",
        message: "A trusted client address is required for route requests."
      },
      400,
      "client_identity"
    );
  }
  const rateLimit = (dependencies.rateLimiter ?? defaultRateLimiter).check(
    clientId,
    (dependencies.now ?? Date.now)()
  );
  if (!rateLimit.allowed) {
    return respond(
      { code: "RATE_LIMITED", message: "Too many route requests. Try again soon." },
      429,
      "rate_limit",
      { "Retry-After": String(rateLimit.retryAfterSeconds) }
    );
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return respond(
      { code: "BODY_TOO_LARGE", message: "Route request is too large." },
      413,
      "body_limit"
    );
  }

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return respond(
      { code: "BODY_TOO_LARGE", message: "Route request is too large." },
      413,
      "body_limit"
    );
  }

  let input: RouteRequestInput;
  try {
    input = routeRequestSchema.parse(JSON.parse(bodyText) as unknown);
  } catch {
    return respond(
      { code: "INVALID_ROUTE_REQUEST", message: "Route request is invalid." },
      400,
      "validation"
    );
  }

  if (!dependencies.apiKey) {
    return respond(
      { code: "ROUTES_NOT_CONFIGURED", message: "Route service is unavailable." },
      503,
      "configuration"
    );
  }

  const upstream = createUpstreamRequestSignal(request.signal);
  try {
    let providerResponse: Response;
    try {
      providerResponse = await dependencies.fetch(HEIGIT_ENDPOINTS.walkingDirections, {
        method: "POST",
        headers: {
          ...createHeiGitHeaders(dependencies.apiKey),
          Accept: "application/geo+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(buildHeiGitRouteRequest(input)),
        signal: upstream.signal
      });
    } catch {
      return respond(
        {
          code: "ROUTES_UNAVAILABLE",
          message: "The walking route service is unavailable."
        },
        503,
        "network"
      );
    }

    if (providerResponse.status === 429) {
      const retryAfter = safeRetryAfter(providerResponse);
      return respond(
        {
          code: "ROUTES_RATE_LIMITED",
          message: "The walking route service is busy. Try again shortly."
        },
        429,
        "upstream_rate_limit",
        retryAfter ? { "Retry-After": retryAfter } : {}
      );
    }
    if (!providerResponse.ok) {
      const unavailable = providerResponse.status >= 500;
      return respond(
        {
          code: unavailable ? "ROUTES_UNAVAILABLE" : "ROUTES_UPSTREAM",
          message: unavailable
            ? "The walking route service is unavailable."
            : "The walking route service could not calculate this walk."
        },
        unavailable ? 503 : 502,
        "upstream"
      );
    }

    let providerPayload: unknown;
    try {
      providerPayload = await providerResponse.json();
    } catch {
      providerPayload = null;
    }
    const parsed = orsResponseSchema.safeParse(providerPayload);
    if (!parsed.success) {
      return respond(
        {
          code: "ROUTES_RESPONSE",
          message: "The walking route provider returned an invalid route."
        },
        502,
        "response"
      );
    }

    const route = parsed.data.features[0]!;
    const coordinates = route.geometry.coordinates;
    let normalized;
    try {
      normalized = routeApiResponseSchema.parse({
        origin: input.origin,
        destination: {
          lat: input.destination.lat,
          lng: input.destination.lng
        },
        encodedPolyline: encodeCoordinates(coordinates),
        distanceMeters: route.properties.summary.distance,
        durationSeconds: Math.round(route.properties.summary.duration),
        steps: route.properties.segments.flatMap((segment) =>
          segment.steps.map((step) => {
            const [start, end] = step.way_points;
            if (start > end || end >= coordinates.length) {
              throw new RangeError("ORS step geometry is outside the route.");
            }
            return {
              instruction: step.instruction,
              maneuver: mapOrsManeuver(step.type),
              distanceMeters: step.distance,
              polyline: encodeCoordinates(coordinates.slice(start, end + 1))
            };
          })
        )
      });
    } catch {
      return respond(
        {
          code: "ROUTES_RESPONSE",
          message: "The walking route provider returned an invalid route."
        },
        502,
        "response"
      );
    }

    return respond(normalized, 200, "success");
  } finally {
    upstream.dispose();
  }
}

function encodeCoordinates(
  coordinates: readonly (readonly [number, number])[]
): string {
  return polylineCodec.encode(coordinates.map(([lng, lat]) => [lat, lng]));
}

export default {
  fetch(request: Request) {
    return handleRouteRequest(request, {
      apiKey: process.env.OPENROUTESERVICE_API_KEY,
      fetch,
      log: (event) => console.info("route_request", event)
    });
  }
};
