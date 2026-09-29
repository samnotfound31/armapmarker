import type { LocalRoutePoint } from "../domain/types";
import { nearestRouteProgress, type RouteMatch } from "../route/progress";

export type ContinuousRouteMatch = RouteMatch & {
  uncertain: boolean;
  /** A previously ambiguous start was resolved to a different route leg. */
  reidentified: boolean;
  /** Clockwise from geographic north; east = PI/2. */
  routeBearingRad: number;
};

export type RouteMatcherInput = {
  position: LocalRoutePoint;
  accuracyMeters: number;
  timestampMs: number;
};

export type RouteMatcherConfig = {
  maximumWalkingSpeedMetersPerSecond: number;
  maximumElapsedSeconds: number;
  maximumUncertaintyAllowanceMeters: number;
  initialMatchUncertain?: boolean;
};

/** Matches topology-continuous progress without changing actual user position. */
export class RouteMatcher {
  private previous: ContinuousRouteMatch | null = null;
  private previousInput: RouteMatcherInput | null = null;
  private readonly config: RouteMatcherConfig;
  private initialAmbiguityPending: boolean;
  private alternateLegEvidence: {
    segmentIndex: number;
    count: number;
    input: RouteMatcherInput;
  } | null = null;

  constructor(
    private readonly route: readonly LocalRoutePoint[],
    private readonly initialProgressMeters = 0,
    config: Partial<RouteMatcherConfig> = {}
  ) {
    if (route.length < 2) throw new RangeError("Route matching requires a segment.");
    this.initialAmbiguityPending = config.initialMatchUncertain === true;
    this.config = {
      maximumWalkingSpeedMetersPerSecond: 3,
      maximumElapsedSeconds: 5,
      maximumUncertaintyAllowanceMeters: 20,
      ...config
    };
  }

  match(input: RouteMatcherInput): ContinuousRouteMatch {
    const candidates: RouteMatch[] = [];
    for (let segmentIndex = 0; segmentIndex < this.route.length - 1; segmentIndex += 1) {
      const candidate = nearestRouteProgress(input.position, [this.route[segmentIndex]!, this.route[segmentIndex + 1]!]);
      candidates.push({ ...candidate, segmentIndex });
    }
    const closest = candidates.reduce((best, candidate) =>
      candidate.crossTrackDistanceMeters < best.crossTrackDistanceMeters ? candidate : best);
    if (this.initialAmbiguityPending && this.isClearInitialWinner(closest, candidates, input.accuracyMeters)) {
      const priorProgress = this.previous?.progressMeters ?? this.initialProgressMeters;
      const elapsedSeconds = this.previousInput
        ? Math.min(this.config.maximumElapsedSeconds,
          Math.max(0, input.timestampMs - this.previousInput.timestampMs) / 1000)
        : 0;
      const uncertaintyMeters = this.previousInput
        ? Math.min(this.config.maximumUncertaintyAllowanceMeters,
          this.previousInput.accuracyMeters + input.accuracyMeters)
        : input.accuracyMeters * 2;
      const maximumProgressChange = this.config.maximumWalkingSpeedMetersPerSecond * elapsedSeconds +
        uncertaintyMeters + 2;
      const nearPrior = Math.abs(closest.progressMeters - priorProgress) <= maximumProgressChange;
      if (nearPrior) {
        this.initialAmbiguityPending = false;
        this.alternateLegEvidence = null;
        return this.commit(closest, input, false);
      }
      const previousEvidence = this.alternateLegEvidence;
      const evidenceElapsedSeconds = previousEvidence
        ? Math.max(0, input.timestampMs - previousEvidence.input.timestampMs) / 1000 : 0;
      const evidenceMovementMeters = previousEvidence
        ? Math.hypot(input.position.eastMeters - previousEvidence.input.position.eastMeters,
          input.position.northMeters - previousEvidence.input.position.northMeters) : 0;
      const evidenceMovementLimit = previousEvidence
        ? this.config.maximumWalkingSpeedMetersPerSecond * Math.min(
          this.config.maximumElapsedSeconds, evidenceElapsedSeconds) +
          Math.min(this.config.maximumUncertaintyAllowanceMeters,
            previousEvidence.input.accuracyMeters + input.accuracyMeters)
        : 0;
      const coherentEvidence = previousEvidence?.segmentIndex === closest.segmentIndex &&
        evidenceElapsedSeconds > 0 && evidenceMovementMeters <= evidenceMovementLimit;
      const count = coherentEvidence ? previousEvidence.count + 1 : 1;
      this.alternateLegEvidence = { segmentIndex: closest.segmentIndex, count, input };
      if (count >= 2) {
        this.initialAmbiguityPending = false;
        this.alternateLegEvidence = null;
        return this.commit(closest, input, false, true);
      }
      return this.previous ? this.hold(input) : this.initialHold(input);
    }
    this.alternateLegEvidence = null;
    if (!this.previous || !this.previousInput) {
      // A start/re-alignment progress prior resolves nearby repeated route legs.
      const near = candidates.filter((candidate) =>
        candidate.crossTrackDistanceMeters <= closest.crossTrackDistanceMeters + input.accuracyMeters &&
        Math.abs(candidate.progressMeters - this.initialProgressMeters) <= input.accuracyMeters * 2 + 2);
      if (near.length === 0) {
        return this.initialHold(input);
      }
      const best = near.reduce((winner, candidate) =>
        candidate.crossTrackDistanceMeters + Math.abs(candidate.progressMeters - this.initialProgressMeters) * 0.05 <
          winner.crossTrackDistanceMeters + Math.abs(winner.progressMeters - this.initialProgressMeters) * 0.05
          ? candidate : winner);
      return this.commit(best, input, this.initialAmbiguityPending);
    }

    const elapsed = Math.min(this.config.maximumElapsedSeconds,
      Math.max(0, input.timestampMs - this.previousInput.timestampMs) / 1000);
    const uncertainty = Math.min(this.config.maximumUncertaintyAllowanceMeters,
      this.previousInput.accuracyMeters + input.accuracyMeters);
    const maximumProgressChange = this.config.maximumWalkingSpeedMetersPerSecond * elapsed + uncertainty + 2;
    const previousProgress = this.previous.progressMeters;
    const movementEast = input.position.eastMeters - this.previousInput.position.eastMeters;
    const movementNorth = input.position.northMeters - this.previousInput.position.northMeters;
    const movementDistance = Math.hypot(movementEast, movementNorth);
    const motionAllowance = movementDistance + Math.hypot(
      this.previousInput.accuracyMeters, input.accuracyMeters);
    const isPlausible = (candidate: RouteMatch): boolean =>
      Math.abs(candidate.progressMeters - previousProgress) <= maximumProgressChange &&
      (Math.abs(candidate.segmentIndex - this.previous!.segmentIndex) <= 1 ||
        Math.abs(candidate.progressMeters - previousProgress) <= motionAllowance);
    const plausible = candidates.filter(isPlausible);
    const score = (candidate: RouteMatch): number => {
      let value = candidate.crossTrackDistanceMeters + Math.abs(candidate.progressMeters - previousProgress) * 0.15;
      if (movementDistance > Math.max(4, input.accuracyMeters)) {
        const bearing = routeBearingAt(this.route, candidate.progressMeters);
        const agreement = (movementEast * Math.sin(bearing) + movementNorth * Math.cos(bearing)) / movementDistance;
        // Both forward walking and backtracking are legitimate; penalize only an
        // inconsistent claimed direction of route progress.
        const progressDirection = Math.sign(candidate.progressMeters - previousProgress);
        if (progressDirection !== 0 && agreement * progressDirection < -0.5) value += input.accuracyMeters;
      }
      return value;
    };
    const best = plausible.sort((a, b) => score(a) - score(b))[0];
    if (!best || best.crossTrackDistanceMeters - closest.crossTrackDistanceMeters > Math.max(5, input.accuracyMeters * 1.2)) {
      return this.hold(input);
    }
    const nearbyUnreachableLeg = candidates.some((candidate) =>
      !isPlausible(candidate) &&
      candidate.crossTrackDistanceMeters <= Math.max(6, input.accuracyMeters * 1.5) &&
      candidate.crossTrackDistanceMeters <= best.crossTrackDistanceMeters + input.accuracyMeters);
    if (nearbyUnreachableLeg) return this.hold(input);
    return this.commit(best, input, this.initialAmbiguityPending);
  }

  private isClearInitialWinner(
    winner: RouteMatch,
    candidates: readonly RouteMatch[],
    accuracyMeters: number
  ): boolean {
    if (winner.crossTrackDistanceMeters > Math.max(3, accuracyMeters * 1.5)) return false;
    const separation = Math.max(20, accuracyMeters * 2);
    const ambiguityMargin = accuracyMeters * 1.2 + 1;
    return !candidates.some((candidate) =>
      Math.abs(candidate.progressMeters - winner.progressMeters) > separation &&
      candidate.crossTrackDistanceMeters <= winner.crossTrackDistanceMeters + ambiguityMargin);
  }

  private initialHold(input: RouteMatcherInput): ContinuousRouteMatch {
    const prior = pointAtProgress(this.route, this.initialProgressMeters);
    return {
      progressMeters: this.initialProgressMeters,
      nearestPoint: prior.point,
      segmentIndex: prior.segmentIndex,
      crossTrackDistanceMeters: Math.hypot(input.position.eastMeters - prior.point.eastMeters,
        input.position.northMeters - prior.point.northMeters),
      routeBearingRad: routeBearingAt(this.route, this.initialProgressMeters),
      uncertain: true,
      reidentified: false
    };
  }

  private hold(input: RouteMatcherInput): ContinuousRouteMatch {
    const previous = this.previous!;
    const held = {
      ...previous,
      crossTrackDistanceMeters: Math.hypot(
        input.position.eastMeters - previous.nearestPoint.eastMeters,
        input.position.northMeters - previous.nearestPoint.northMeters),
      uncertain: true,
      reidentified: false
    };
    // An implausible fix cannot widen the next continuity window or establish
    // a new prior. Reacquisition is explicit through rerouting/re-alignment.
    return held;
  }

  private commit(match: RouteMatch, input: RouteMatcherInput, uncertain: boolean, reidentified = false): ContinuousRouteMatch {
    const result = { ...match, uncertain, reidentified, routeBearingRad: routeBearingAt(this.route, match.progressMeters) };
    this.previous = result;
    this.previousInput = input;
    return result;
  }
}

export function routeBearingAt(route: readonly LocalRoutePoint[], progressMeters: number): number {
  let segment = route.length - 2;
  for (let index = 0; index < route.length - 1; index += 1) {
    if (route[index + 1]!.routeDistanceMeters > progressMeters + 0.01) {
      segment = index;
      break;
    }
  }
  const start = route[segment]!;
  const end = route[segment + 1]!;
  const bearing = Math.atan2(end.eastMeters - start.eastMeters, end.northMeters - start.northMeters);
  return (bearing + Math.PI * 2) % (Math.PI * 2);
}

function pointAtProgress(route: readonly LocalRoutePoint[], progressMeters: number): { point: LocalRoutePoint; segmentIndex: number } {
  let segmentIndex = route.length - 2;
  for (let index = 0; index < route.length - 1; index += 1) {
    if (route[index + 1]!.routeDistanceMeters >= progressMeters) { segmentIndex = index; break; }
  }
  const start = route[segmentIndex]!;
  const end = route[segmentIndex + 1]!;
  const length = end.routeDistanceMeters - start.routeDistanceMeters;
  const fraction = length <= 0 ? 0 : Math.max(0, Math.min(1, (progressMeters - start.routeDistanceMeters) / length));
  return {
    segmentIndex,
    point: {
      eastMeters: start.eastMeters + (end.eastMeters - start.eastMeters) * fraction,
      northMeters: start.northMeters + (end.northMeters - start.northMeters) * fraction,
      upMeters: start.upMeters + (end.upMeters - start.upMeters) * fraction,
      routeDistanceMeters: progressMeters
    }
  };
}
