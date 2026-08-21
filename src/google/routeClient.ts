import type { Destination, GeoPoint, RoutePlan } from "../domain/types";
import {
  routeApiResponseSchema,
  routePlanSchema,
  routeRequestSchema
} from "./routeSchemas";

export type WalkingRouteInput = {
  origin: GeoPoint;
  destination: Destination;
};

export class RouteClientError extends Error {
  public readonly name = "RouteClientError";

  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

export async function requestWalkingRoute(
  input: WalkingRouteInput,
  signal: AbortSignal
): Promise<RoutePlan> {
  const requestBody = routeRequestSchema.parse({
    origin: input.origin,
    destination: {
      placeId: input.destination.placeId,
      lat: input.destination.location.lat,
      lng: input.destination.location.lng
    }
  });
  const response = await fetch("/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const fallback = {
      code: "ROUTE_REQUEST_FAILED",
      message: "The walking route could not be loaded."
    };
    const error = await readError(response, fallback);
    throw new RouteClientError(
      error.code,
      error.message,
      response.status,
      response.status >= 500 || response.status === 429
    );
  }

  const apiRoute = routeApiResponseSchema.parse(await response.json());
  return routePlanSchema.parse({
    ...apiRoute,
    destination: {
      ...apiRoute.destination,
      name: input.destination.name
    }
  });
}

async function readError(
  response: Response,
  fallback: { code: string; message: string }
): Promise<{ code: string; message: string }> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return { code: body.code, message: body.message };
    }
  } catch {
    return fallback;
  }
  return fallback;
}
