import type {
  GeoPoint,
  LocalRoutePoint,
  RouteGroundPoint,
  RoutePlan
} from "../domain/types";
import type { LocationFix } from "../device/location";
import { createRouteFrame, toEnu, toRouteLocal, type RouteFrame } from "./geo";
import { decodeAndSampleRoute, normalizeRouteGeometry } from "./polyline";
import { nearestRouteProgress, type RouteMatch } from "./progress";

export type PreparedRoute = {
  enuOrigin: GeoPoint;
  localRoute: LocalRoutePoint[];
  groundRoute: RouteGroundPoint[];
  calibrationRoutePoint: RouteGroundPoint;
  calibrationProgressMeters: number;
  initialActualPositionRoute: RouteGroundPoint;
  routeBearingRad: number;
  routeFrame: RouteFrame;
  normalizedRoute: RoutePlan;
  initialMatchUncertain: boolean;
};

export function prepareRoute(
  route: RoutePlan,
  fix: LocationFix,
  previousProgressMeters?: number
): PreparedRoute {
  const normalizedRoute = normalizeRouteGeometry(route);
  const enuOrigin = { ...route.origin };
  const localRoute = decodeAndSampleRoute(
    route.encodedPolyline,
    2.5,
    enuOrigin
  );
  const actualPosition = toEnu(fix.point, enuOrigin);
  const { match, uncertain } = initialRouteMatch(
    actualPosition, localRoute, fix.accuracyMeters, previousProgressMeters
  );
  const segmentStart = localRoute[match.segmentIndex]!;
  const segmentEnd = localRoute[match.segmentIndex + 1]!;
  const tangentBearingRad = Math.atan2(
    segmentEnd.eastMeters - segmentStart.eastMeters,
    segmentEnd.northMeters - segmentStart.northMeters
  );
  const frame = createRouteFrame(match.nearestPoint, tangentBearingRad);
  const groundRoute = localRoute.map((point) => toRouteLocal(point, frame));
  const calibrationRoutePoint = toRouteLocal(match.nearestPoint, frame);

  return {
    enuOrigin,
    localRoute,
    groundRoute,
    calibrationRoutePoint,
    calibrationProgressMeters: match.progressMeters,
    initialActualPositionRoute: toRouteLocal(actualPosition, frame),
    routeBearingRad: tangentBearingRad,
    routeFrame: frame,
    normalizedRoute,
    initialMatchUncertain: uncertain
  };
}

function initialRouteMatch(
  position: LocalRoutePoint,
  route: readonly LocalRoutePoint[],
  accuracyMeters: number,
  previousProgressMeters?: number
): { match: RouteMatch; uncertain: boolean } {
  const accuracy = Number.isFinite(accuracyMeters) ? Math.max(0, accuracyMeters) : 0;
  const reachableDistanceMeters = Math.max(20, accuracy * 2);
  if (previousProgressMeters !== undefined && Number.isFinite(previousProgressMeters)) {
    const previous = clamp(previousProgressMeters, 0, route.at(-1)!.routeDistanceMeters);
    const startProgress = Math.max(0, previous - reachableDistanceMeters);
    const endProgress = Math.min(route.at(-1)!.routeDistanceMeters, previous + reachableDistanceMeters);
    const nearby = [
      sampleLocalRoutePoint(route, startProgress),
      ...route.filter((point) =>
        point.routeDistanceMeters > startProgress && point.routeDistanceMeters < endProgress
      ),
      sampleLocalRoutePoint(route, endProgress)
    ];
    const candidate = nearestRouteProgress(position, nearby);
    const uncertain = candidate.crossTrackDistanceMeters > reachableDistanceMeters;
    const nearestPoint = uncertain
      ? sampleLocalRoutePoint(route, previous)
      : candidate.nearestPoint;
    return {
      match: {
        nearestPoint,
        progressMeters: nearestPoint.routeDistanceMeters,
        crossTrackDistanceMeters: Math.hypot(
          position.eastMeters - nearestPoint.eastMeters,
          position.northMeters - nearestPoint.northMeters
        ),
        segmentIndex: segmentAtProgress(route, nearestPoint.routeDistanceMeters)
      },
      uncertain
    };
  }

  const match = nearestRouteProgress(position, route);
  const uncertaintyCorridorMeters = Math.max(2, accuracy);
  const ambiguous = route.some((start, index) => {
    const end = route[index + 1];
    if (!end) return false;
    const candidate = nearestRouteProgress(position, [start, end]);
    return Math.abs(candidate.progressMeters - match.progressMeters) > reachableDistanceMeters &&
      candidate.crossTrackDistanceMeters <= uncertaintyCorridorMeters &&
      candidate.crossTrackDistanceMeters <= match.crossTrackDistanceMeters + uncertaintyCorridorMeters;
  });
  return {
    match,
    uncertain: ambiguous || match.crossTrackDistanceMeters > reachableDistanceMeters
  };
}

function sampleLocalRoutePoint(
  route: readonly LocalRoutePoint[],
  progressMeters: number
): LocalRoutePoint {
  const index = segmentAtProgress(route, progressMeters);
  const start = route[index]!;
  const end = route[index + 1]!;
  const fraction = clamp(
    (progressMeters - start.routeDistanceMeters) /
      (end.routeDistanceMeters - start.routeDistanceMeters),
    0,
    1
  );
  return {
    eastMeters: start.eastMeters + (end.eastMeters - start.eastMeters) * fraction,
    northMeters: start.northMeters + (end.northMeters - start.northMeters) * fraction,
    upMeters: start.upMeters + (end.upMeters - start.upMeters) * fraction,
    routeDistanceMeters: start.routeDistanceMeters +
      (end.routeDistanceMeters - start.routeDistanceMeters) * fraction
  };
}

function segmentAtProgress(route: readonly LocalRoutePoint[], progressMeters: number): number {
  const index = route.findIndex((point, pointIndex) =>
    pointIndex > 0 && point.routeDistanceMeters >= progressMeters
  );
  return index > 0 ? index - 1 : route.length - 2;
}

export function sampleRouteGroundPoint(
  route: readonly RouteGroundPoint[],
  progressMeters: number
): RouteGroundPoint {
  if (route.length < 2) throw new RangeError("Ground route requires two points.");
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const end = route[index + 1]!;
    if (
      progressMeters > end.routeDistanceMeters &&
      index < route.length - 2
    ) {
      continue;
    }
    const delta = end.routeDistanceMeters - start.routeDistanceMeters;
    const fraction =
      delta <= 0
        ? 0
        : clamp(
            (progressMeters - start.routeDistanceMeters) / delta,
            0,
            1
          );
    return {
      rightMeters:
        start.rightMeters + (end.rightMeters - start.rightMeters) * fraction,
      upMeters: start.upMeters + (end.upMeters - start.upMeters) * fraction,
      forwardMeters:
        start.forwardMeters +
        (end.forwardMeters - start.forwardMeters) * fraction,
      routeDistanceMeters: start.routeDistanceMeters + delta * fraction
    };
  }
  return route.at(-1)!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
