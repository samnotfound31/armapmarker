import { decode } from "@googlemaps/polyline-codec";
import type { GeoPoint, LocalRoutePoint } from "../domain/types";
import { toEnu } from "./geo";

const DISTANCE_EPSILON_METERS = 1e-6;

export function decodeAndSampleRoute(
  encoded: string,
  spacingMeters: number,
  enuOrigin?: GeoPoint
): LocalRoutePoint[] {
  if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
    throw new RangeError("Route sample spacing must be greater than zero");
  }

  const decoded = decode(encoded);
  if (decoded.length < 2) {
    throw new RangeError("A route requires at least two points");
  }

  const firstCoordinate = decoded[0]!;
  const origin: GeoPoint = enuOrigin ?? {
    lat: firstCoordinate[0],
    lng: firstCoordinate[1]
  };
  const source = decoded.map(([lat, lng]) => toEnu({ lat, lng }, origin));
  const firstPoint = source[0]!;
  const samples: LocalRoutePoint[] = [withRouteDistance(firstPoint, 0)];
  let segmentStartDistanceMeters = 0;
  let nextSampleDistanceMeters = spacingMeters;

  for (let index = 1; index < source.length; index += 1) {
    const start = source[index - 1]!;
    const end = source[index]!;
    const segmentLengthMeters = horizontalDistance(start, end);
    const segmentEndDistanceMeters =
      segmentStartDistanceMeters + segmentLengthMeters;

    if (segmentLengthMeters > DISTANCE_EPSILON_METERS) {
      while (
        nextSampleDistanceMeters <=
        segmentEndDistanceMeters + DISTANCE_EPSILON_METERS
      ) {
        const fraction = Math.min(
          1,
          (nextSampleDistanceMeters - segmentStartDistanceMeters) /
            segmentLengthMeters
        );
        samples.push(
          interpolatePoint(start, end, fraction, nextSampleDistanceMeters)
        );
        nextSampleDistanceMeters += spacingMeters;
      }
    }

    segmentStartDistanceMeters = segmentEndDistanceMeters;
  }

  const destination = source.at(-1)!;
  const lastSample = samples.at(-1)!;
  if (
    Math.abs(lastSample.routeDistanceMeters - segmentStartDistanceMeters) <=
    DISTANCE_EPSILON_METERS
  ) {
    samples[samples.length - 1] = withRouteDistance(
      destination,
      segmentStartDistanceMeters
    );
  } else {
    samples.push(withRouteDistance(destination, segmentStartDistanceMeters));
  }

  return samples;
}

function horizontalDistance(
  first: LocalRoutePoint,
  second: LocalRoutePoint
): number {
  return Math.hypot(
    second.eastMeters - first.eastMeters,
    second.northMeters - first.northMeters
  );
}

function interpolatePoint(
  start: LocalRoutePoint,
  end: LocalRoutePoint,
  fraction: number,
  routeDistanceMeters: number
): LocalRoutePoint {
  return {
    eastMeters: start.eastMeters + (end.eastMeters - start.eastMeters) * fraction,
    northMeters:
      start.northMeters + (end.northMeters - start.northMeters) * fraction,
    upMeters: start.upMeters + (end.upMeters - start.upMeters) * fraction,
    routeDistanceMeters
  };
}

function withRouteDistance(
  point: LocalRoutePoint,
  routeDistanceMeters: number
): LocalRoutePoint {
  return { ...point, routeDistanceMeters };
}
