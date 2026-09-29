import type { LocalRoutePoint, NavigationGeographicState, RouteStep, TrackingQuality } from "../domain/types";
import type { LocationConfidence } from "../device/AcceptedLocationFilter";
import { MonotonicProgressFilter, ProgressSmoother, hasArrived } from "../route/progress";
import { RouteMatcher, routeBearingAt, type ContinuousRouteMatch } from "./RouteMatcher";

export type NavigationEngineInput = {
  position: LocalRoutePoint;
  gpsAccuracyMeters: number;
  distanceToDestinationMeters: number;
  /** Monotonic application time; source GPS epoch time is metadata only. */
  timestampMs: number;
  trackingQuality: TrackingQuality;
  calibrationDisagreement: boolean;
  locationQuality?: LocationConfidence;
  locationUsable?: boolean;
  headingReliable?: boolean;
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
  geographicState?: NavigationGeographicState;
  matchedSegmentIndex?: number;
  crossTrackDistanceMeters?: number;
  routeBearingRad?: number;
  movementAgreement?: number | null;
};

export type NavigationEngineUpdate = { accepted: boolean; snapshot: NavigationSnapshot };
export type GeographicAvailability = { locationUsable: boolean; headingReliable: boolean };

export type NavigationDecisionConfig = {
  maximumUsableAccuracyMeters: number;
  offRouteCorridorMeters: number;
  offRouteEntryFixes: number;
  recoveryFixes: number;
  motionEvidenceMinimumMeters: number;
  wrongWayEvidenceWindows: number;
  deviationEvidenceWindows: number;
  initialMatchUncertain?: boolean;
};

type MotionAnchor = {
  position: LocalRoutePoint;
  progressMeters: number;
  futureDistanceMeters: number;
  accuracyMeters: number;
};

export class NavigationEngine {
  private smoother: ProgressSmoother;
  private readonly progressFilter: MonotonicProgressFilter;
  private readonly matcher: RouteMatcher;
  private readonly config: NavigationDecisionConfig;
  private lastTimestampMs: number | null = null;
  private offRouteFixes = 0;
  private recoveryFixes = 0;
  private disagreementFrames = 0;
  private wrongWayEvidence = 0;
  private forwardEvidence = 0;
  private deviationEvidence = 0;
  private motionRecoveryEvidence = 0;
  private offRoute = false;
  private wrongWay = false;
  private deviated = false;
  private routeMatchUncertain = false;
  private availability: GeographicAvailability = { locationUsable: true, headingReliable: true };
  private motionAnchor: MotionAnchor | null = null;
  private movementAgreement: number | null = null;
  private snapshotValue: NavigationSnapshot | null = null;

  constructor(
    private readonly route: readonly LocalRoutePoint[],
    private readonly steps: readonly RouteStep[],
    private readonly routeDistanceMeters: number,
    private readonly initialProgressMeters = 0,
    config: Partial<NavigationDecisionConfig> = {}
  ) {
    if (route.length < 2) throw new RangeError("Navigation requires a route segment.");
    if (!Number.isFinite(routeDistanceMeters) || routeDistanceMeters <= 0) {
      throw new RangeError("Navigation route distance must be positive.");
    }
    this.config = {
      maximumUsableAccuracyMeters: 15,
      offRouteCorridorMeters: 20,
      offRouteEntryFixes: 3,
      recoveryFixes: 2,
      motionEvidenceMinimumMeters: 4,
      wrongWayEvidenceWindows: 2,
      deviationEvidenceWindows: 2,
      ...config
    };
    this.smoother = new ProgressSmoother(initialProgressMeters, 1.5);
    // This filter ignores small backward GPS jitter but permits real backtracking.
    // Topological continuity is independently enforced by RouteMatcher.
    this.progressFilter = new MonotonicProgressFilter(initialProgressMeters, 5);
    this.matcher = new RouteMatcher(route, initialProgressMeters, {
      initialMatchUncertain: this.config.initialMatchUncertain
    });
  }

  update(input: NavigationEngineInput): NavigationEngineUpdate {
    if (this.lastTimestampMs !== null && input.timestampMs <= this.lastTimestampMs) {
      return { accepted: false, snapshot: this.snapshotValue! };
    }
    this.availability.headingReliable = input.headingReliable ?? this.availability.headingReliable;
    const usable = input.locationUsable !== false &&
      (input.locationQuality === undefined || input.locationQuality === "GOOD") &&
      Number.isFinite(input.gpsAccuracyMeters) && input.gpsAccuracyMeters >= 0 &&
      input.gpsAccuracyMeters <= this.config.maximumUsableAccuracyMeters &&
      Number.isFinite(input.position.eastMeters) && Number.isFinite(input.position.northMeters) &&
      Number.isFinite(input.timestampMs);
    this.availability.locationUsable = usable;
    if (!usable) {
      const previous = this.snapshotValue ?? this.initialSnapshot(input);
      this.snapshotValue = { ...previous, geographicState: this.geographicState(), arrived: false, timestampMs: input.timestampMs };
      return { accepted: false, snapshot: this.snapshotValue };
    }

    const match = this.matcher.match({ position: input.position, timestampMs: input.timestampMs, accuracyMeters: input.gpsAccuracyMeters });
    this.routeMatchUncertain = match.uncertain;
    const acceptedGpsProgressMeters = this.progressFilter.update(match.progressMeters);
    if (match.reidentified) {
      // The old smoothed leg is geographically wrong; the new leg has two
      // precise, spatially consistent GPS fixes and may become the route origin.
      this.smoother = new ProgressSmoother(acceptedGpsProgressMeters, 1.5);
    }
    const dtSeconds = this.lastTimestampMs === null ? 0 : (input.timestampMs - this.lastTimestampMs) / 1000;
    this.lastTimestampMs = input.timestampMs;
    const routeProgressMeters = this.smoother.update(acceptedGpsProgressMeters, dtSeconds, input.gpsAccuracyMeters);
    this.updateOffRoute(match.crossTrackDistanceMeters, input.gpsAccuracyMeters);
    if (!match.uncertain) this.updateMotion(input, match);
    this.disagreementFrames = input.calibrationDisagreement ? this.disagreementFrames + 1 : 0;
    const geographicState = this.geographicState();
    this.snapshotValue = {
      routeProgressMeters,
      acceptedGpsProgressMeters,
      remainingDistanceMeters: Math.max(0, this.routeDistanceMeters - routeProgressMeters),
      nextManeuver: selectNextManeuver(this.steps, routeProgressMeters),
      offRoute: this.offRoute,
      trackingQuality: input.trackingQuality,
      arrived: !this.routeMatchUncertain && !this.offRoute && !this.wrongWay && !this.deviated && hasArrived(
        acceptedGpsProgressMeters, this.routeDistanceMeters, input.distanceToDestinationMeters),
      realignRequired: this.disagreementFrames >= 10,
      timestampMs: input.timestampMs,
      geographicState,
      matchedSegmentIndex: match.segmentIndex,
      crossTrackDistanceMeters: match.crossTrackDistanceMeters,
      routeBearingRad: match.routeBearingRad,
      movementAgreement: this.movementAgreement
    };
    return { accepted: true, snapshot: this.snapshotValue };
  }

  /** A freshness/heading watchdog changes confidence without advancing GPS state. */
  setGeographicAvailability(availability: GeographicAvailability, timestampMs: number): NavigationSnapshot | null {
    this.availability = availability;
    if (!this.snapshotValue) return null;
    this.snapshotValue = {
      ...this.snapshotValue,
      geographicState: this.geographicState(),
      arrived: availability.locationUsable && this.snapshotValue.arrived,
      timestampMs
    };
    return this.snapshotValue;
  }

  private initialSnapshot(input: NavigationEngineInput): NavigationSnapshot {
    return {
      routeProgressMeters: this.initialProgressMeters,
      acceptedGpsProgressMeters: this.initialProgressMeters,
      remainingDistanceMeters: Math.max(0, this.routeDistanceMeters - this.initialProgressMeters),
      nextManeuver: selectNextManeuver(this.steps, this.initialProgressMeters),
      offRoute: false, trackingQuality: input.trackingQuality, arrived: false,
      realignRequired: false, timestampMs: input.timestampMs,
      geographicState: this.geographicState(), matchedSegmentIndex: 0,
      crossTrackDistanceMeters: 0, routeBearingRad: routeBearingAt(this.route, this.initialProgressMeters),
      movementAgreement: null
    };
  }

  private geographicState(): NavigationGeographicState {
    if (!this.availability.locationUsable) return "LOCATION_UNCERTAIN";
    if (this.offRoute) return "OFF_ROUTE";
    if (this.wrongWay) return "WRONG_WAY";
    if (this.deviated) return "DEVIATED";
    if (this.routeMatchUncertain) return "ROUTE_MATCH_UNCERTAIN";
    if (!this.availability.headingReliable) return "HEADING_UNCERTAIN";
    return "VALID";
  }

  private updateOffRoute(crossTrackMeters: number, accuracyMeters: number): void {
    const corridor = Math.max(this.config.offRouteCorridorMeters, accuracyMeters * 1.5);
    const outside = crossTrackMeters > corridor;
    const inside = crossTrackMeters <= corridor * 0.65;
    if (!this.offRoute) {
      this.offRouteFixes = outside ? this.offRouteFixes + 1 : 0;
      if (this.offRouteFixes >= this.config.offRouteEntryFixes) {
        this.offRoute = true;
        this.recoveryFixes = 0;
      }
      return;
    }
    this.recoveryFixes = inside ? this.recoveryFixes + 1 : 0;
    if (this.recoveryFixes >= this.config.recoveryFixes) {
      this.offRoute = false;
      this.offRouteFixes = 0;
      this.recoveryFixes = 0;
    }
  }

  private updateMotion(input: NavigationEngineInput, match: ContinuousRouteMatch): void {
    const futureDistance = distanceToRouteProgress(input.position, this.route, Math.min(this.routeDistanceMeters, match.progressMeters + 8));
    if (!this.motionAnchor) {
      this.motionAnchor = { position: input.position, progressMeters: match.progressMeters,
        futureDistanceMeters: futureDistance, accuracyMeters: input.gpsAccuracyMeters };
      return;
    }
    const anchor = this.motionAnchor;
    const east = input.position.eastMeters - anchor.position.eastMeters;
    const north = input.position.northMeters - anchor.position.northMeters;
    const distance = Math.hypot(east, north);
    if (distance < Math.max(this.config.motionEvidenceMinimumMeters,
      Math.max(anchor.accuracyMeters, input.gpsAccuracyMeters) * 1.2)) return;
    const agreement = (east * Math.sin(match.routeBearingRad) + north * Math.cos(match.routeBearingRad)) / distance;
    this.movementAgreement = agreement;
    const progressDelta = match.progressMeters - anchor.progressMeters;
    const backward = agreement < -0.6 && progressDelta < -Math.max(2, input.gpsAccuracyMeters * 0.3);
    const forward = agreement > 0.5 && progressDelta > Math.max(1, input.gpsAccuracyMeters * 0.2);
    this.wrongWayEvidence = backward ? this.wrongWayEvidence + 1 : 0;
    this.forwardEvidence = forward ? this.forwardEvidence + 1 : 0;
    if (this.wrongWayEvidence >= this.config.wrongWayEvidenceWindows) this.wrongWay = true;
    if (this.forwardEvidence >= this.config.recoveryFixes) this.wrongWay = false;

    const stagnating = progressDelta < distance * 0.35;
    const diverging = futureDistance - anchor.futureDistanceMeters > Math.max(1, input.gpsAccuracyMeters * 0.2);
    const outsideNarrowCorridor = match.crossTrackDistanceMeters > Math.max(6, input.gpsAccuracyMeters * 1.25);
    const missedPath = agreement < 0.35 && stagnating && diverging && outsideNarrowCorridor && !backward;
    this.deviationEvidence = missedPath ? this.deviationEvidence + 1 : 0;
    if (this.deviationEvidence >= this.config.deviationEvidenceWindows) this.deviated = true;
    this.motionRecoveryEvidence = forward && !outsideNarrowCorridor ? this.motionRecoveryEvidence + 1 : 0;
    if (this.motionRecoveryEvidence >= this.config.recoveryFixes) this.deviated = false;
    this.motionAnchor = { position: input.position, progressMeters: match.progressMeters,
      futureDistanceMeters: futureDistance, accuracyMeters: input.gpsAccuracyMeters };
  }
}

/** An upcoming turn is located at its geometry start anchor, not its step length. */
export function selectNextManeuver(steps: readonly RouteStep[], progressMeters: number): NextManeuver | null {
  const anchored = steps.map((step, index) => ({ step, index })).filter(({ step }) =>
    Number.isFinite(step.routeProgressMeters) && step.routeProgressMeters! >= 0);
  const isContinue = (maneuver: string) => /^(STRAIGHT|CONTINUE|DEPART|HEAD)$/i.test(maneuver);
  const upcoming = anchored.find(({ step }) => !isContinue(step.maneuver) && step.routeProgressMeters! >= progressMeters);
  const current = anchored.filter(({ step }) => step.routeProgressMeters! <= progressMeters).at(-1);
  const selected = upcoming ?? current;
  if (!selected) return null;
  return {
    instruction: selected.step.instruction,
    maneuver: selected.step.maneuver,
    distanceToManeuverMeters: upcoming ? Math.max(0, selected.step.routeProgressMeters! - progressMeters) : 0,
    stepIndex: selected.index
  };
}

function distanceToRouteProgress(position: LocalRoutePoint, route: readonly LocalRoutePoint[], progressMeters: number): number {
  let segment = route.length - 2;
  for (let index = 0; index < route.length - 1; index += 1) {
    if (route[index + 1]!.routeDistanceMeters >= progressMeters) { segment = index; break; }
  }
  const start = route[segment]!;
  const end = route[segment + 1]!;
  const span = end.routeDistanceMeters - start.routeDistanceMeters;
  const fraction = span <= 0 ? 0 : Math.max(0, Math.min(1, (progressMeters - start.routeDistanceMeters) / span));
  return Math.hypot(position.eastMeters - (start.eastMeters + (end.eastMeters - start.eastMeters) * fraction),
    position.northMeters - (start.northMeters + (end.northMeters - start.northMeters) * fraction));
}
