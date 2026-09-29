import { decode } from "@googlemaps/polyline-codec";
import type { GeoPoint, LocalRoutePoint, RoutePlan, RouteStep } from "../domain/types";
import { toEnu } from "./geo";

const DISTANCE_EPSILON_METERS = 1e-6;
const STEP_POINT_TOLERANCE_METERS = 0.05;

export function decodeAndSampleRoute(
  encoded: string,
  spacingMeters: number,
  enuOrigin?: GeoPoint
): LocalRoutePoint[] {
  if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
    throw new RangeError("Route sample spacing must be greater than zero");
  }

  const source = decodeRouteVertices(encoded, enuOrigin);
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

    // Retain every provider vertex as well as the fixed-spacing samples. A
    // regular sample either side of a corner must not replace the corner.
    const lastSample = samples.at(-1)!;
    if (
      Math.abs(lastSample.routeDistanceMeters - segmentEndDistanceMeters) <=
      DISTANCE_EPSILON_METERS
    ) {
      samples[samples.length - 1] = withRouteDistance(end, segmentEndDistanceMeters);
    } else {
      samples.push(withRouteDistance(end, segmentEndDistanceMeters));
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

/**
 * Route and maneuver progress share the decoded geometry's cumulative distance.
 * Provider step distances remain metadata and never determine a turn's position.
 */
export function normalizeRouteGeometry(route: RoutePlan): RoutePlan {
  const source = decodeRouteVertices(route.encodedPolyline, route.origin);
  let previousEndIndex = 0;
  let previousStepMatched = true;
  const steps = route.steps.map((step): RouteStep => {
    const unanchoredStep = { ...step };
    delete unanchoredStep.routeProgressMeters;
    let stepPoints: LocalRoutePoint[];
    try {
      stepPoints = decodeCoordinates(step.polyline).map(([lat, lng]) =>
        toEnu({ lat, lng }, route.origin)
      );
    } catch {
      previousStepMatched = false;
      return unanchoredStep;
    }

    const matches: { startIndex: number; endIndex: number }[] = [];
    for (let index = previousEndIndex; index < source.length; index += 1) {
      const endIndex = matchStepPath(source, stepPoints, index);
      if (endIndex === undefined) continue;
      matches.push({ startIndex: index, endIndex });
    }

    // Consecutive step geometries normally share their endpoint. Prefer that
    // exact occurrence; if coverage is missing, require an unambiguous path.
    const continuation = previousStepMatched
      ? matches.find((match) => match.startIndex === previousEndIndex)
      : undefined;
    const match = continuation ?? (matches.length === 1 ? matches[0] : undefined);
    if (!match) {
      previousStepMatched = false;
      return unanchoredStep;
    }

    previousEndIndex = match.endIndex;
    previousStepMatched = true;
    return {
      ...unanchoredStep,
      routeProgressMeters: source[match.startIndex]!.routeDistanceMeters
    };
  });

  return {
    ...route,
    distanceMeters: source.at(-1)!.routeDistanceMeters,
    steps
  };
}

function decodeRouteVertices(encoded: string, enuOrigin?: GeoPoint): LocalRoutePoint[] {
  const decoded = decodeCoordinates(encoded);
  if (decoded.length < 2) {
    throw new RangeError("A route requires at least two points");
  }
  const first = decoded[0]!;
  const origin: GeoPoint = enuOrigin ?? { lat: first[0], lng: first[1] };
  const source: LocalRoutePoint[] = [];
  let distanceMeters = 0;
  for (const [lat, lng] of decoded) {
    const point = toEnu({ lat, lng }, origin);
    const previous = source.at(-1);
    const segmentLength = previous ? horizontalDistance(previous, point) : 0;
    if (previous && segmentLength <= DISTANCE_EPSILON_METERS) continue;
    distanceMeters += segmentLength;
    source.push(withRouteDistance(point, distanceMeters));
  }
  if (source.length < 2) {
    throw new RangeError("A route requires at least two distinct points");
  }
  return source;
}

function decodeCoordinates(encoded: string): [number, number][] {
  if (!encoded || !/^[?-~]+$/.test(encoded)) {
    throw new RangeError("Route polyline is malformed");
  }
  const decoded = decode(encoded);
  if (
    decoded.length === 0 ||
    decoded.some(([lat, lng]) =>
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    )
  ) {
    throw new RangeError("Route coordinates are invalid");
  }
  return decoded;
}

function matchStepPath(
  source: readonly LocalRoutePoint[],
  stepPoints: readonly LocalRoutePoint[],
  startIndex: number
): number | undefined {
  let routeIndex = startIndex;
  let previousStepPoint: LocalRoutePoint | undefined;
  for (const point of stepPoints) {
    if (
      previousStepPoint &&
      horizontalDistance(previousStepPoint, point) <= DISTANCE_EPSILON_METERS
    ) continue;
    if (previousStepPoint) routeIndex += 1;
    const routePoint = source[routeIndex];
    if (!routePoint || horizontalDistance(routePoint, point) > STEP_POINT_TOLERANCE_METERS) {
      return undefined;
    }
    previousStepPoint = point;
  }
  return routeIndex;
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
