import type {
  LocalRoutePoint,
  RouteStep,
  TrackingQuality
} from "../domain/types";
import {
  MonotonicProgressFilter,
  ProgressSmoother,
  hasArrived,
  nearestRouteProgress
} from "../route/progress";

export type NavigationEngineInput = {
  position: LocalRoutePoint;
  gpsAccuracyMeters: number;
  distanceToDestinationMeters: number;
  timestampMs: number;
  trackingQuality: TrackingQuality;
  calibrationDisagreement: boolean;
};

export type NextManeuver = {
  instruction: string;
  maneuver: string;
  distanceToManeuverMeters: number;
  stepIndex: number;
};

export type NavigationSnapshot = {
  routeProgressMeters: number;
  acceptedGpsProgressMeters: number;
  remainingDistanceMeters: number;
  nextManeuver: NextManeuver | null;
  offRoute: boolean;
  trackingQuality: TrackingQuality;
  arrived: boolean;
  realignRequired: boolean;
  timestampMs: number;
};

export type NavigationEngineUpdate = {
  accepted: boolean;
  snapshot: NavigationSnapshot;
};

const OFF_ROUTE_CORRIDOR_METERS = 20;
const MAXIMUM_DECISION_ACCURACY_METERS = 15;
const OFF_ROUTE_ENTRY_FIXES = 3;
const OFF_ROUTE_RECOVERY_FIXES = 2;
const REALIGN_DISAGREEMENT_FRAMES = 10;

export class NavigationEngine {
  private readonly smoother: ProgressSmoother;
  private readonly progressFilter: MonotonicProgressFilter;
  private lastTimestampMs: number | null = null;
  private offRouteFixes = 0;
  private recoveryFixes = 0;
  private disagreementFrames = 0;
  private offRoute = false;
  private snapshotValue: NavigationSnapshot | null = null;

  constructor(
    private readonly route: readonly LocalRoutePoint[],
    private readonly steps: readonly RouteStep[],
    private readonly routeDistanceMeters: number,
    initialProgressMeters = 0
  ) {
    if (route.length < 2) throw new RangeError("Navigation requires a route segment.");
    if (!Number.isFinite(routeDistanceMeters) || routeDistanceMeters <= 0) {
      throw new RangeError("Navigation route distance must be positive.");
    }
    this.smoother = new ProgressSmoother(initialProgressMeters, 1.5);
    this.progressFilter = new MonotonicProgressFilter(initialProgressMeters, 5);
  }

  update(input: NavigationEngineInput): NavigationEngineUpdate {
    if (this.lastTimestampMs !== null && input.timestampMs <= this.lastTimestampMs) {
      if (!this.snapshotValue) throw new Error("Navigation snapshot is unavailable.");
      return { accepted: false, snapshot: this.snapshotValue };
    }

    const match = nearestRouteProgress(input.position, this.route);
    const acceptedGpsProgressMeters = this.progressFilter.update(match.progressMeters);
    const dtSeconds =
      this.lastTimestampMs === null ? 0 : (input.timestampMs - this.lastTimestampMs) / 1000;
    this.lastTimestampMs = input.timestampMs;
    const routeProgressMeters = this.smoother.update(
      acceptedGpsProgressMeters,
      dtSeconds,
      input.gpsAccuracyMeters
    );

    this.updateOffRoute(match.crossTrackDistanceMeters, input.gpsAccuracyMeters);
    this.disagreementFrames = input.calibrationDisagreement
      ? this.disagreementFrames + 1
      : 0;
    this.snapshotValue = {
      routeProgressMeters,
      acceptedGpsProgressMeters,
      remainingDistanceMeters: Math.max(0, this.routeDistanceMeters - routeProgressMeters),
      nextManeuver: selectNextManeuver(this.steps, routeProgressMeters),
      offRoute: this.offRoute,
      trackingQuality: input.trackingQuality,
      arrived: hasArrived(
        acceptedGpsProgressMeters,
        this.routeDistanceMeters,
        input.distanceToDestinationMeters
      ),
      realignRequired: this.disagreementFrames >= REALIGN_DISAGREEMENT_FRAMES,
      timestampMs: input.timestampMs
    };
    return { accepted: true, snapshot: this.snapshotValue };
  }

  private updateOffRoute(crossTrackMeters: number, accuracyMeters: number): void {
    const accurate = accuracyMeters <= MAXIMUM_DECISION_ACCURACY_METERS;
    const outside = accurate && crossTrackMeters > OFF_ROUTE_CORRIDOR_METERS;
    const inside = accurate && crossTrackMeters <= OFF_ROUTE_CORRIDOR_METERS;
    if (!this.offRoute) {
      this.offRouteFixes = outside ? this.offRouteFixes + 1 : 0;
      if (this.offRouteFixes >= OFF_ROUTE_ENTRY_FIXES) {
        this.offRoute = true;
        this.recoveryFixes = 0;
      }
      return;
    }
    this.recoveryFixes = inside ? this.recoveryFixes + 1 : 0;
    if (this.recoveryFixes >= OFF_ROUTE_RECOVERY_FIXES) {
      this.offRoute = false;
      this.offRouteFixes = 0;
      this.recoveryFixes = 0;
    }
  }
}

export function selectNextManeuver(
  steps: readonly RouteStep[],
  progressMeters: number
): NextManeuver | null {
  let cumulativeDistanceMeters = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    cumulativeDistanceMeters += step.distanceMeters;
    if (progressMeters < cumulativeDistanceMeters || index === steps.length - 1) {
      return {
        instruction: step.instruction,
        maneuver: step.maneuver,
        distanceToManeuverMeters: Math.max(0, cumulativeDistanceMeters - progressMeters),
        stepIndex: index
      };
    }
  }
  return null;
}
