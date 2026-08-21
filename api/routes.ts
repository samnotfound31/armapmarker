import { z } from "zod";
import {
  routeApiResponseSchema,
  routeRequestSchema,
  type RouteRequestInput
} from "../src/google/routeSchemas";

const MAX_BODY_BYTES = 8 * 1024;
const GOOGLE_ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

export const ROUTES_FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.navigationInstruction"
].join(",");

const googleResponseSchema = z.object({
  routes: z
    .array(
      z.object({
        duration: z.string().regex(/^\d+(?:\.\d+)?s$/),
        distanceMeters: z.number().nonnegative(),
        polyline: z.object({ encodedPolyline: z.string().min(1) }),
        legs: z.array(
          z.object({
            steps: z.array(
              z.object({
                distanceMeters: z.number().nonnegative(),
                polyline: z.object({ encodedPolyline: z.string().min(1) }),
                navigationInstruction: z
                  .object({
                    maneuver: z.string().optional(),
                    instructions: z.string().optional()
                  })
                  .optional()
              })
            )
          })
        )
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
};

export function buildGoogleRequest(input: RouteRequestInput) {
  return {
    origin: {
      location: {
        latLng: {
          latitude: input.origin.lat,
          longitude: input.origin.lng
        }
      }
    },
    destination: {
      location: {
        latLng: {
          latitude: input.destination.lat,
          longitude: input.destination.lng
        }
      }
    },
    travelMode: "WALK",
    polylineQuality: "HIGH_QUALITY"
  } as const;
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
    category: string
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

  let googleResponse: Response;
  try {
    googleResponse = await dependencies.fetch(GOOGLE_ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": dependencies.apiKey,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK
      },
      body: JSON.stringify(buildGoogleRequest(input)),
      signal: request.signal
    });
  } catch {
    return respond(
      { code: "ROUTES_UNAVAILABLE", message: "Google Routes is unavailable." },
      503,
      "network"
    );
  }

  if (!googleResponse.ok) {
    return respond(
      {
        code: "ROUTES_UPSTREAM",
        message: "Google Routes could not calculate this walk."
      },
      502,
      "upstream"
    );
  }

  const parsed = googleResponseSchema.safeParse(await googleResponse.json());
  if (!parsed.success) {
    return respond(
      { code: "ROUTES_RESPONSE", message: "Google Routes returned an invalid route." },
      502,
      "response"
    );
  }

  const route = parsed.data.routes[0]!;
  const normalized = routeApiResponseSchema.parse({
    origin: input.origin,
    destination: {
      lat: input.destination.lat,
      lng: input.destination.lng
    },
    encodedPolyline: route.polyline.encodedPolyline,
    distanceMeters: route.distanceMeters,
    durationSeconds: Math.round(Number.parseFloat(route.duration)),
    steps: route.legs.flatMap((leg) =>
      leg.steps.map((step) => ({
        instruction: step.navigationInstruction?.instructions ?? "Continue",
        maneuver: step.navigationInstruction?.maneuver ?? "STRAIGHT",
        distanceMeters: step.distanceMeters,
        polyline: step.polyline.encodedPolyline
      }))
    )
  });

  return respond(normalized, 200, "success");
}

export default {
  fetch(request: Request) {
    return handleRouteRequest(request, {
      apiKey: process.env.GOOGLE_ROUTES_SERVER_KEY,
      fetch,
      log: (event) => console.info("route_request", event)
    });
  }
};
