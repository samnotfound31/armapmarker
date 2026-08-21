import { z } from "zod";

const latitudeSchema = z.number().finite().min(-90).max(90);
const longitudeSchema = z.number().finite().min(-180).max(180);

export const geoPointSchema = z
  .object({
    lat: latitudeSchema,
    lng: longitudeSchema,
    altitudeMeters: z.number().finite().optional()
  })
  .strict();

export const routeRequestSchema = z
  .object({
    origin: geoPointSchema,
    destination: z
      .object({
        placeId: z.string().trim().min(1).max(512),
        lat: latitudeSchema,
        lng: longitudeSchema
      })
      .strict()
  })
  .strict();

export const routeStepSchema = z
  .object({
    instruction: z.string(),
    maneuver: z.string(),
    distanceMeters: z.number().finite().nonnegative(),
    polyline: z.string().min(1)
  })
  .strict();

export const routeApiResponseSchema = z
  .object({
    origin: geoPointSchema,
    destination: geoPointSchema,
    encodedPolyline: z.string().min(1),
    distanceMeters: z.number().finite().nonnegative(),
    durationSeconds: z.number().int().nonnegative(),
    steps: z.array(routeStepSchema)
  })
  .strict();

export const routePlanSchema = routeApiResponseSchema.extend({
  destination: geoPointSchema.extend({ name: z.string().trim().min(1) })
});

export type RouteRequestInput = z.infer<typeof routeRequestSchema>;
export type RouteApiResponse = z.infer<typeof routeApiResponseSchema>;
