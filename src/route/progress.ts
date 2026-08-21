import type { LocalRoutePoint } from "../domain/types";

export type RouteMatch = {
  progressMeters: number;
  crossTrackDistanceMeters: number;
  nearestPoint: LocalRoutePoint;
  segmentIndex: number;
};

export type RouteDistanceReading = {
  crossTrackDistanceMeters: number;
  accuracyMeters: number;
};

export function nearestRouteProgress(
  position: LocalRoutePoint,
  route: readonly LocalRoutePoint[]
): RouteMatch {
  if (route.length < 2) {
    throw new RangeError("Progress matching requires at least two route points");
  }

  let nearest: RouteMatch | undefined;

  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const end = route[index + 1]!;
    const eastDelta = end.eastMeters - start.eastMeters;
    const northDelta = end.northMeters - start.northMeters;
    const lengthSquared = eastDelta ** 2 + northDelta ** 2;
    const fraction =
      lengthSquared === 0
        ? 0
        : clamp(
            ((position.eastMeters - start.eastMeters) * eastDelta +
              (position.northMeters - start.northMeters) * northDelta) /
              lengthSquared,
            0,
            1
          );
    const nearestPoint: LocalRoutePoint = {
      eastMeters: start.eastMeters + eastDelta * fraction,
      northMeters: start.northMeters + northDelta * fraction,
      upMeters: start.upMeters + (end.upMeters - start.upMeters) * fraction,
      routeDistanceMeters:
        start.routeDistanceMeters +
        (end.routeDistanceMeters - start.routeDistanceMeters) * fraction
    };
    const crossTrackDistanceMeters = Math.hypot(
      position.eastMeters - nearestPoint.eastMeters,
      position.northMeters - nearestPoint.northMeters
    );

    if (
      !nearest ||
      crossTrackDistanceMeters < nearest.crossTrackDistanceMeters
    ) {
      nearest = {
        progressMeters: nearestPoint.routeDistanceMeters,
        crossTrackDistanceMeters,
        nearestPoint,
        segmentIndex: index
      };
    }
  }

  return nearest!;
}

export class ProgressSmoother {
  private velocityMetersPerSecond = 0;

  public constructor(
    private valueMeters: number,
    private readonly timeConstantSeconds = 1.5,
    private readonly walkingSpeedMetersPerSecond = 2.5
  ) {}

  public update(
    targetMeters: number,
    dtSeconds: number,
    reportedAccuracyMeters = 0
  ): number {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return this.valueMeters;
    }

    const omega = 2 / this.timeConstantSeconds;
    const displacement = this.valueMeters - targetMeters;
    const velocityTerm =
      this.velocityMetersPerSecond + omega * displacement;
    const decay = Math.exp(-omega * dtSeconds);
    const candidate =
      targetMeters +
      (displacement + velocityTerm * dtSeconds) * decay;
    const candidateVelocity =
      (this.velocityMetersPerSecond - omega * velocityTerm * dtSeconds) *
      decay;
    const accuracyMeters = Math.max(0, reportedAccuracyMeters);
    const maximumSpeed =
      this.walkingSpeedMetersPerSecond +
      accuracyMeters / Math.max(dtSeconds, 1);
    const maximumDelta = maximumSpeed * dtSeconds;
    const next = clamp(
      candidate,
      this.valueMeters - maximumDelta,
      this.valueMeters + maximumDelta
    );

    this.velocityMetersPerSecond =
      next === candidate
        ? candidateVelocity
        : (next - this.valueMeters) / dtSeconds;
    this.valueMeters = next;
    return next;
  }
}

export class MonotonicProgressFilter {
  private valueMeters: number;
  private initialized = false;

  public constructor(
    initialMeters = 0,
    private readonly backwardJitterToleranceMeters = 5
  ) {
    this.valueMeters = initialMeters;
  }

  public update(candidateMeters: number): number {
    if (!Number.isFinite(candidateMeters)) return this.valueMeters;
    const candidate = Math.max(0, candidateMeters);
    if (!this.initialized) {
      this.valueMeters = candidate;
      this.initialized = true;
      return this.valueMeters;
    }
    if (
      candidate < this.valueMeters &&
      this.valueMeters - candidate <= this.backwardJitterToleranceMeters
    ) {
      return this.valueMeters;
    }
    this.valueMeters = candidate;
    return this.valueMeters;
  }
}

export function isOffRoute(
  readings: readonly RouteDistanceReading[],
  corridorMeters = 20,
  maximumAccuracyMeters = 15,
  requiredConsecutiveReadings = 3
): boolean {
  if (readings.length < requiredConsecutiveReadings) {
    return false;
  }

  return readings
    .slice(-requiredConsecutiveReadings)
    .every(
      ({ crossTrackDistanceMeters, accuracyMeters }) =>
        crossTrackDistanceMeters > corridorMeters &&
        accuracyMeters <= maximumAccuracyMeters
    );
}

export function hasArrived(
  progressMeters: number,
  routeDistanceMeters: number,
  distanceToDestinationMeters: number,
  progressRatio = 0.95,
  arrivalRadiusMeters = 20
): boolean {
  return (
    routeDistanceMeters > 0 &&
    progressMeters >= routeDistanceMeters * progressRatio &&
    distanceToDestinationMeters <= arrivalRadiusMeters
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
