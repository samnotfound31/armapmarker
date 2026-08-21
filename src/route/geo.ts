import type {
  GeoPoint,
  LocalRoutePoint,
  RouteGroundPoint
} from "../domain/types";

const EARTH_RADIUS_METERS = 6_378_137;

type EnuOrigin = Pick<
  LocalRoutePoint,
  "eastMeters" | "northMeters" | "upMeters"
>;

export type RouteFrame = {
  origin: EnuOrigin;
  tangentBearingRad: number;
};

export function toEnu(point: GeoPoint, origin: GeoPoint): LocalRoutePoint {
  const lat0 = degreesToRadians(origin.lat);
  const dLat = degreesToRadians(point.lat - origin.lat);
  const dLng = degreesToRadians(point.lng - origin.lng);

  return {
    eastMeters: EARTH_RADIUS_METERS * Math.cos(lat0) * dLng,
    northMeters: EARTH_RADIUS_METERS * dLat,
    upMeters: (point.altitudeMeters ?? 0) - (origin.altitudeMeters ?? 0),
    routeDistanceMeters: 0
  };
}

export function createRouteFrame(
  origin: EnuOrigin,
  tangentBearingRad: number
): RouteFrame {
  return { origin: { ...origin }, tangentBearingRad };
}

export function toRouteLocal(
  point: LocalRoutePoint,
  frame: RouteFrame
): RouteGroundPoint {
  const eastMeters = point.eastMeters - frame.origin.eastMeters;
  const northMeters = point.northMeters - frame.origin.northMeters;
  const sinBearing = Math.sin(frame.tangentBearingRad);
  const cosBearing = Math.cos(frame.tangentBearingRad);

  return {
    rightMeters: eastMeters * cosBearing - northMeters * sinBearing,
    upMeters: point.upMeters - frame.origin.upMeters,
    forwardMeters: eastMeters * sinBearing + northMeters * cosBearing,
    routeDistanceMeters: point.routeDistanceMeters
  };
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
