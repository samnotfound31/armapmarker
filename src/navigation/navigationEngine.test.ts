import { describe, expect, it } from "vitest";
import type {
  LocalRoutePoint,
  RouteStep,
  TrackingQuality
} from "../domain/types";
import { NavigationEngine, selectNextManeuver } from "./navigationEngine";

const LOCKED_QUALITY: TrackingQuality = {
  state: "locked",
  featureCount: 40,
  inlierCount: 30,
  inlierRatio: 0.75,
  medianReprojectionErrorPx: 1
};
const ROUTE = [point(0, 0, 0), point(0, 50, 50), point(0, 100, 100)];
const STEPS: RouteStep[] = [
  { instruction: "Continue straight", maneuver: "STRAIGHT", distanceMeters: 60, polyline: "" },
  { instruction: "Turn left", maneuver: "TURN_LEFT", distanceMeters: 40, polyline: "" }
];

describe("NavigationEngine", () => {
  it("smooths snapped GPS progress with the 1.5-second response", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    engine.update(input(0, 0, 0));
    const snapshot = engine.update(input(10, 0, 1500)).snapshot;

    expect(snapshot.routeProgressMeters).toBeGreaterThan(4);
    expect(snapshot.routeProgressMeters).toBeLessThan(8);
    expect(snapshot.remainingDistanceMeters).toBeCloseTo(
      100 - snapshot.routeProgressMeters
    );
  });

  it("starts smoothing and monotonic filtering at a nonzero re-alignment match", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 60);

    const snapshot = engine.update(input(61, 0, 1000)).snapshot;

    expect(snapshot.routeProgressMeters).toBe(60);
    expect(snapshot.acceptedGpsProgressMeters).toBe(61);
    expect(snapshot.remainingDistanceMeters).toBe(40);
  });

  it("ignores small backward GPS jitter but accepts genuine backtracking", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    engine.update(input(30, 0, 0));
    const forward = engine.update(input(40, 0, 1500)).snapshot;
    const jitter = engine.update(input(38, 0, 3000)).snapshot;
    expect(jitter.acceptedGpsProgressMeters).toBe(40);
    expect(jitter.routeProgressMeters).toBeGreaterThanOrEqual(forward.routeProgressMeters);

    const backtrack = engine.update(input(25, 0, 4500)).snapshot;
    expect(backtrack.acceptedGpsProgressMeters).toBe(25);
  });

  it("enters off-route after three accurate fixes and recovers after two", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    expect(engine.update(input(10, 25, 0)).snapshot.offRoute).toBe(false);
    expect(engine.update(input(11, 25, 1000)).snapshot.offRoute).toBe(false);
    expect(engine.update(input(12, 25, 2000)).snapshot.offRoute).toBe(true);
    expect(engine.update(input(13, 5, 3000)).snapshot.offRoute).toBe(true);
    expect(engine.update(input(14, 5, 4000)).snapshot.offRoute).toBe(false);
  });

  it("selects the next maneuver and detects arrival inside the configured radius", () => {
    expect(selectNextManeuver(STEPS, 10)).toMatchObject({
      instruction: "Continue straight",
      distanceToManeuverMeters: 50
    });
    expect(selectNextManeuver(STEPS, 65)).toMatchObject({
      instruction: "Turn left",
      distanceToManeuverMeters: 35
    });

    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    const arrived = engine.update(input(96, 0, 1000, 10)).snapshot;
    expect(arrived.arrived).toBe(true);
  });

  it("requires persistent calibration disagreement before realignment", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    for (let index = 0; index < 9; index += 1) {
      expect(engine.update(input(10, 0, index * 100, 90, true)).snapshot.realignRequired).toBe(false);
    }
    expect(engine.update(input(10, 0, 900, 90, true)).snapshot.realignRequired).toBe(true);
  });

  it("returns an explicit rejection outcome for repeated and stale timestamps", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    const accepted = engine.update(input(20, 0, 2000));
    const repeated = engine.update(input(80, 0, 2000));
    const stale = engine.update(input(90, 0, 1500));

    expect(accepted).toMatchObject({ accepted: true });
    expect(repeated).toEqual({ accepted: false, snapshot: accepted.snapshot });
    expect(stale).toEqual({ accepted: false, snapshot: accepted.snapshot });
  });
});

function input(
  northMeters: number,
  eastMeters: number,
  timestampMs: number,
  distanceToDestinationMeters = 100 - northMeters,
  calibrationDisagreement = false
) {
  return {
    position: point(eastMeters, northMeters, 0),
    gpsAccuracyMeters: 5,
    distanceToDestinationMeters,
    timestampMs,
    trackingQuality: LOCKED_QUALITY,
    calibrationDisagreement
  };
}

function point(
  eastMeters: number,
  northMeters: number,
  routeDistanceMeters: number
): LocalRoutePoint {
  return { eastMeters, northMeters, upMeters: 0, routeDistanceMeters };
}
