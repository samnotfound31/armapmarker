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
  { instruction: "Continue straight", maneuver: "STRAIGHT", distanceMeters: 60, polyline: "", routeProgressMeters: 0 },
  { instruction: "Turn left", maneuver: "TURN_LEFT", distanceMeters: 40, polyline: "", routeProgressMeters: 60 },
  { instruction: "Arrive", maneuver: "ARRIVE", distanceMeters: 0, polyline: "", routeProgressMeters: 100 }
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
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 30);
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
    expect(engine.update(input(12, 25, 2500)).snapshot.geographicState).toBe("OFF_ROUTE");
    expect(engine.update(input(13, 5, 3000)).snapshot.offRoute).toBe(true);
    expect(engine.update(input(14, 5, 4000)).snapshot.offRoute).toBe(false);
    expect(engine.update(input(14, 5, 4500)).snapshot.geographicState).toBe("VALID");
  });

  it("keeps a confirmed off-route warning actionable when compass heading is unavailable", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    for (const timestampMs of [0, 1000, 2000]) {
      engine.update({ ...input(10, 25, timestampMs), headingReliable: false });
    }
    expect(engine.setGeographicAvailability({ locationUsable: true, headingReliable: false }, 2500))
      .toMatchObject({ offRoute: true, geographicState: "OFF_ROUTE" });
  });

  it("selects the next maneuver and detects arrival inside the configured radius", () => {
    expect(selectNextManeuver(STEPS, 10)).toMatchObject({
      instruction: "Turn left",
      distanceToManeuverMeters: 50
    });
    expect(selectNextManeuver(STEPS, 65)).toMatchObject({
      instruction: "Arrive",
      distanceToManeuverMeters: 35
    });

    const engine = new NavigationEngine(ROUTE, STEPS, 100, 96);
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
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 20);
    const accepted = engine.update(input(20, 0, 2000));
    const repeated = engine.update(input(80, 0, 2000));
    const stale = engine.update(input(90, 0, 1500));

    expect(accepted).toMatchObject({ accepted: true });
    expect(repeated).toEqual({ accepted: false, snapshot: accepted.snapshot });
    expect(stale).toEqual({ accepted: false, snapshot: accepted.snapshot });
  });

  it("does not advance or arrive on a 100-metre accuracy fix", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    engine.update(input(10, 0, 0));
    const result = engine.update({ ...input(99, 0, 1000, 1), gpsAccuracyMeters: 100 });
    expect(result.accepted).toBe(false);
    expect(result.snapshot.acceptedGpsProgressMeters).toBe(10);
    expect(result.snapshot.arrived).toBe(false);
    expect(result.snapshot.geographicState).toBe("LOCATION_UNCERTAIN");
  });

  it("separates heading/location availability from locked visual tracking", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100);
    const missingHeading = engine.update({ ...input(0, 0, 0), headingReliable: false });
    expect(missingHeading.snapshot.geographicState).toBe("HEADING_UNCERTAIN");
    expect(missingHeading.snapshot.trackingQuality.state).toBe("locked");
    const recovered = engine.update({ ...input(1, 0, 1000), headingReliable: true });
    expect(recovered.snapshot.geographicState).toBe("VALID");
    const expired = engine.setGeographicAvailability({ locationUsable: false, headingReliable: true }, 7000);
    expect(expired?.geographicState).toBe("LOCATION_UNCERTAIN");
    expect(expired?.arrived).toBe(false);
  });

  it("keeps progress on the correct leg across small lateral out-and-back jitter", () => {
    const parallel = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const engine = new NavigationEngine(parallel, [], 206, 30);
    engine.update(input(30, 2.9, 0));
    const next = engine.update(input(30, 3.1, 1000)).snapshot;
    expect(next.acceptedGpsProgressMeters).toBeCloseTo(30);
    expect(next.matchedSegmentIndex).toBe(0);
  });

  it("keeps geographic guidance uncertain until an ambiguous initial route leg resolves", () => {
    const parallel = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const engine = new NavigationEngine(parallel, [], 206, 30, { initialMatchUncertain: true });
    expect(engine.update(input(30, 0, 0)).snapshot.geographicState).toBe("ROUTE_MATCH_UNCERTAIN");
    expect(engine.update(input(45, 0, 5000)).snapshot.geographicState).toBe("ROUTE_MATCH_UNCERTAIN");
    const resolved = engine.update({ ...input(60, 0, 10000), gpsAccuracyMeters: 2 }).snapshot;
    expect(resolved.geographicState).toBe("VALID");
    expect(resolved.acceptedGpsProgressMeters).toBeCloseTo(60);
  });

  it("suppresses guidance when a short loop's return leg is reached by a lateral jump", () => {
    const loop = [point(0, 0, 0), point(0, 20, 20), point(6, 20, 26), point(6, 0, 46)];
    const engine = new NavigationEngine(loop, [], 46, 10);
    engine.update(input(10, 0, 0));
    const lateral = engine.update(input(10, 6, 5000)).snapshot;
    expect(lateral.acceptedGpsProgressMeters).toBe(10);
    expect(lateral.geographicState).toBe("ROUTE_MATCH_UNCERTAIN");
  });

  it("realigns displayed progress before restoring guidance on a confirmed alternate leg", () => {
    const parallel = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const engine = new NavigationEngine(parallel, [], 206, 30, { initialMatchUncertain: true });
    engine.update(input(30, 3, 0));
    expect(engine.update({ ...input(30, 6, 5000), gpsAccuracyMeters: 2 }).snapshot.geographicState)
      .toBe("ROUTE_MATCH_UNCERTAIN");
    const confirmed = engine.update({ ...input(30, 6, 10000), gpsAccuracyMeters: 2 }).snapshot;
    expect(confirmed).toMatchObject({
      acceptedGpsProgressMeters: 176,
      routeProgressMeters: 176,
      geographicState: "VALID"
    });
  });

  it("detects sustained actual backward movement and recovers after forward evidence", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 50);
    engine.update(input(50, 0, 0));
    engine.update(input(44, 0, 5000));
    expect(engine.update(input(38, 0, 10000)).snapshot.geographicState).toBe("WRONG_WAY");
    engine.update(input(44, 0, 15000));
    expect(engine.update(input(50, 0, 20000)).snapshot.geographicState).toBe("VALID");
  });

  it("does not classify stationary GPS jitter as wrong way", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 30);
    [30, 29, 31, 28, 30, 29, 31, 30].forEach((north, index) => {
      expect(engine.update(input(north, index % 2, index * 1000)).snapshot.geographicState)
        .not.toBe("WRONG_WAY");
    });
  });

  it("detects walking past a right turn without advancing down the eastbound leg", () => {
    const corner = [point(0, 0, 0), point(0, 20, 20), point(20, 20, 40)];
    const engine = new NavigationEngine(corner, [], 40, 16);
    [16, 22, 28, 34].forEach((north, index) => engine.update(input(north, 0, index * 5000)));
    const final = engine.update(input(40, 0, 20000)).snapshot;
    expect(final.acceptedGpsProgressMeters).toBe(20);
    expect(final.geographicState).toBe("DEVIATED");
    expect(final.trackingQuality.state).toBe("locked");
  });

  it("uses geometry-anchored turn distances when provider step distances disagree", () => {
    const steps: RouteStep[] = [
      { instruction: "Continue north", maneuver: "STRAIGHT", distanceMeters: 22, polyline: "", routeProgressMeters: 0 },
      { instruction: "Turn right", maneuver: "TURN_RIGHT", distanceMeters: 18, polyline: "", routeProgressMeters: 20 },
      { instruction: "Arrive", maneuver: "ARRIVE", distanceMeters: 0, polyline: "", routeProgressMeters: 40 }
    ];
    expect(selectNextManeuver(steps, 12)).toMatchObject({ instruction: "Turn right", distanceToManeuverMeters: 8 });
    expect(selectNextManeuver(steps, 21)).toMatchObject({ instruction: "Arrive", distanceToManeuverMeters: 19 });
    expect(selectNextManeuver([{ ...steps[1]!, routeProgressMeters: undefined }], 12)).toBeNull();
  });

  it("recovers a missed turn only after returning to the path and moving forward", () => {
    const corner = [point(0, 0, 0), point(0, 20, 20), point(20, 20, 40)];
    const engine = new NavigationEngine(corner, [], 40, 16);
    [16, 22, 28, 34].forEach((north, index) => engine.update(input(north, 0, index * 5000)));
    expect(engine.update(input(40, 0, 20000)).snapshot.geographicState).toBe("DEVIATED");
    engine.update(input(28, 0, 25000));
    engine.update(input(20, 0, 30000));
    expect(engine.update(input(20, 6, 35000)).snapshot.geographicState).toBe("DEVIATED");
    expect(engine.update(input(20, 12, 40000)).snapshot.geographicState).toBe("VALID");
  });

  it("does not combine a less precise motion anchor with improved GPS into false wrong-way evidence", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 40);
    engine.update({ ...input(40, 0, 0), gpsAccuracyMeters: 15 });
    engine.update(input(34, 0, 5000));
    expect(engine.update(input(28, 0, 10000)).snapshot.geographicState).not.toBe("WRONG_WAY");
    engine.update(input(22, 0, 15000));
    expect(engine.update(input(16, 0, 20000)).snapshot.geographicState).toBe("WRONG_WAY");
  });

  it("exposes uncertain matching instead of confident guidance after an impossible progress jump", () => {
    const engine = new NavigationEngine(ROUTE, STEPS, 100, 10);
    engine.update(input(10, 0, 0));
    const next = engine.update(input(99, 0, 1000, 1)).snapshot;
    expect(next.acceptedGpsProgressMeters).toBe(10);
    expect(next.arrived).toBe(false);
    expect(next.geographicState).not.toBe("VALID");
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
