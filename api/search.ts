import { z } from "zod";
import { createHeiGitHeaders, HEIGIT_ENDPOINTS } from "./providers/heigitConfig";
import {
  createUpstreamRequestSignal,
  safeRetryAfter
} from "./providers/upstreamRequest";
import {
  createClientRateLimiter,
  trustedClientId,
  type ClientRateLimiter
} from "./requestPolicy";

const MAX_BODY_BYTES = 2 * 1024;
const longitudeSchema = z.number().finite().min(-180).max(180);
const latitudeSchema = z.number().finite().min(-90).max(90);
const searchRequestSchema = z
  .object({
    query: z.string().trim().min(2).max(200),
    origin: z
      .object({ lat: latitudeSchema, lng: longitudeSchema })
      .strict()
      .optional()
  })
  .strict();
const peliasResponseSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(
    z.object({
      type: z.literal("Feature"),
      geometry: z.object({
        type: z.literal("Point"),
        coordinates: z.tuple([longitudeSchema, latitudeSchema])
      }),
      properties: z.object({
        gid: z.string().trim().min(1).max(512),
        name: z.string().trim().min(1).max(300),
        label: z.string().trim().min(1).max(600)
      })
    })
  )
});

type SearchDependencies = {
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

const defaultRateLimiter = createClientRateLimiter({
  limit: 60,
  windowMs: 60_000,
  maxClients: 10_000
});

export async function handleSearchRequest(
  request: Request,
  dependencies: SearchDependencies
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
      { code: "CROSS_ORIGIN", message: "Cross-origin search requests are blocked." },
      403,
      "cross_origin"
    );
  }
  if (request.method !== "POST") {
    return respond(
      { code: "METHOD_NOT_ALLOWED", message: "Use POST for destination search." },
      405,
      "method"
    );
  }

  const clientId = trustedClientId(request);
  if (!clientId) {
    return respond(
      {
        code: "CLIENT_ID_REQUIRED",
        message: "A trusted client address is required for destination search."
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
      { code: "RATE_LIMITED", message: "Too many searches. Try again soon." },
      429,
      "rate_limit",
      { "Retry-After": String(rateLimit.retryAfterSeconds) }
    );
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return respond(
      { code: "BODY_TOO_LARGE", message: "Search request is too large." },
      413,
      "body_limit"
    );
  }
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return respond(
      { code: "BODY_TOO_LARGE", message: "Search request is too large." },
      413,
      "body_limit"
    );
  }

  const parsedInput = searchRequestSchema.safeParse(safeJson(bodyText));
  if (!parsedInput.success) {
    return respond(
      { code: "INVALID_SEARCH_REQUEST", message: "Search request is invalid." },
      400,
      "validation"
    );
  }
  if (!dependencies.apiKey) {
    return respond(
      { code: "SEARCH_NOT_CONFIGURED", message: "Destination search is unavailable." },
      503,
      "configuration"
    );
  }

  const providerUrl = new URL(HEIGIT_ENDPOINTS.autocomplete);
  providerUrl.searchParams.set("text", parsedInput.data.query);
  providerUrl.searchParams.set("size", "5");
  providerUrl.searchParams.set("lang", "en");
  if (parsedInput.data.origin) {
    providerUrl.searchParams.set(
      "focus.point.lat",
      String(parsedInput.data.origin.lat)
    );
    providerUrl.searchParams.set(
      "focus.point.lon",
      String(parsedInput.data.origin.lng)
    );
  }

  const upstream = createUpstreamRequestSignal(request.signal);
  try {
    let providerResponse: Response;
    try {
      providerResponse = await dependencies.fetch(providerUrl, {
        method: "GET",
        headers: createHeiGitHeaders(dependencies.apiKey),
        signal: upstream.signal
      });
    } catch {
      return respond(
        { code: "SEARCH_UNAVAILABLE", message: "Destination search is unavailable." },
        503,
        "network"
      );
    }
    if (providerResponse.status === 429) {
      const retryAfter = safeRetryAfter(providerResponse);
      return respond(
        {
          code: "SEARCH_RATE_LIMITED",
          message: "Destination search is busy. Try again shortly."
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
          code: unavailable ? "SEARCH_UNAVAILABLE" : "SEARCH_UPSTREAM",
          message: unavailable
            ? "Destination search is unavailable."
            : "Destination search could not be completed."
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
    const parsedProvider = peliasResponseSchema.safeParse(providerPayload);
    if (!parsedProvider.success) {
      return respond(
        {
          code: "SEARCH_RESPONSE",
          message: "The destination provider returned invalid results."
        },
        502,
        "response"
      );
    }

    return respond(
      {
        suggestions: parsedProvider.data.features.map((feature) => ({
          placeId: feature.properties.gid,
          name: feature.properties.name,
          formattedAddress: feature.properties.label,
          location: {
            lat: feature.geometry.coordinates[1],
            lng: feature.geometry.coordinates[0]
          }
        }))
      },
      200,
      "success"
    );
  } finally {
    upstream.dispose();
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export default {
  fetch(request: Request) {
    return handleSearchRequest(request, {
      apiKey: process.env.OPENROUTESERVICE_API_KEY,
      fetch,
      log: (event) => console.info("destination_search", event)
    });
  }
};
