import type {
  GeoPoint,
  LocalRoutePoint,
  RouteGroundPoint,
  RoutePlan
} from "../domain/types";
import type { LocationFix } from "../device/location";
import { createRouteFrame, toEnu, toRouteLocal } from "./geo";
import { decodeAndSampleRoute } from "./polyline";
import { nearestRouteProgress } from "./progress";

export type PreparedRoute = {
  enuOrigin: GeoPoint;
  localRoute: LocalRoutePoint[];
  groundRoute: RouteGroundPoint[];
  calibrationRoutePoint: RouteGroundPoint;
  calibrationProgressMeters: number;
};

export function prepareRoute(route: RoutePlan, fix: LocationFix): PreparedRoute {
  const enuOrigin = { ...route.origin };
  const localRoute = decodeAndSampleRoute(
    route.encodedPolyline,
    2.5,
    enuOrigin
  );
  const match = nearestRouteProgress(toEnu(fix.point, enuOrigin), localRoute);
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
    calibrationProgressMeters: match.progressMeters
  };
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
