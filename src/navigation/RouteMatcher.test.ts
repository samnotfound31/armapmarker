import { describe, expect, it } from "vitest";
import type { LocalRoutePoint } from "../domain/types";
import { RouteMatcher } from "./RouteMatcher";

describe("RouteMatcher", () => {
  it("does not switch to a nearby topologically distant return leg", () => {
    const route = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const matcher = new RouteMatcher(route, 30);
    matcher.match({ position: point(2.9, 30, 0), timestampMs: 0, accuracyMeters: 5 });
    const match = matcher.match({ position: point(3.1, 30, 0), timestampMs: 1000, accuracyMeters: 5 });
    expect(match.progressMeters).toBeCloseTo(30);
    expect(match.segmentIndex).toBe(0);
  });

  it("does not confidently jump across a short loop after one lateral GPS move", () => {
    const route = [point(0, 0, 0), point(0, 20, 20), point(6, 20, 26), point(6, 0, 46)];
    const matcher = new RouteMatcher(route, 10);
    matcher.match({ position: point(0, 10, 0), timestampMs: 0, accuracyMeters: 5 });
    const lateral = matcher.match({ position: point(6, 10, 0), timestampMs: 5000, accuracyMeters: 5 });
    expect(lateral).toMatchObject({ progressMeters: 10, segmentIndex: 0, uncertain: true });
  });

  it("keeps an ambiguous initial leg uncertain until GPS resolves the nearby return leg", () => {
    const route = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const matcher = new RouteMatcher(route, 30, { initialMatchUncertain: true });
    const first = matcher.match({ position: point(0, 30, 0), timestampMs: 0, accuracyMeters: 5 });
    expect(first).toMatchObject({ progressMeters: 30, segmentIndex: 0, uncertain: true });
    const stillAmbiguous = matcher.match({ position: point(0, 45, 0), timestampMs: 5000, accuracyMeters: 5 });
    expect(stillAmbiguous).toMatchObject({ progressMeters: 45, segmentIndex: 0, uncertain: true });
    const resolved = matcher.match({ position: point(0, 60, 0), timestampMs: 10000, accuracyMeters: 2 });
    expect(resolved).toMatchObject({ progressMeters: 60, segmentIndex: 0, uncertain: false });
  });

  it("reidentifies the other initial leg only after repeated precise fixes", () => {
    const route = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const matcher = new RouteMatcher(route, 30, { initialMatchUncertain: true });
    matcher.match({ position: point(3, 30, 0), timestampMs: 0, accuracyMeters: 5 });
    const firstPrecise = matcher.match({ position: point(6, 30, 0), timestampMs: 5000, accuracyMeters: 2 });
    expect(firstPrecise).toMatchObject({ progressMeters: 30, segmentIndex: 0, uncertain: true });
    const confirmed = matcher.match({ position: point(6, 30, 0), timestampMs: 10000, accuracyMeters: 2 });
    expect(confirmed).toMatchObject({ progressMeters: 176, segmentIndex: 2, uncertain: false });
  });

  it("does not combine spatially inconsistent alternate-leg fixes into reidentification", () => {
    const route = [point(0, 0, 0), point(0, 100, 100), point(6, 100, 106), point(6, 0, 206)];
    const matcher = new RouteMatcher(route, 30, { initialMatchUncertain: true });
    matcher.match({ position: point(3, 30, 0), timestampMs: 0, accuracyMeters: 5 });
    matcher.match({ position: point(6, 30, 0), timestampMs: 5000, accuracyMeters: 2 });
    const inconsistent = matcher.match({ position: point(6, 80, 0), timestampMs: 6000, accuracyMeters: 2 });
    expect(inconsistent).toMatchObject({ progressMeters: 30, uncertain: true });
  });

  it("accepts forward walking around a bend and genuine slow backtracking", () => {
    const route = [point(0, 0, 0), point(0, 20, 20), point(20, 20, 40)];
    const matcher = new RouteMatcher(route, 17);
    matcher.match({ position: point(0, 17, 0), timestampMs: 0, accuracyMeters: 3 });
    expect(matcher.match({ position: point(2, 20, 0), timestampMs: 3000, accuracyMeters: 3 }))
      .toMatchObject({ progressMeters: 22, segmentIndex: 1, uncertain: false });
    expect(matcher.match({ position: point(0, 19, 0), timestampMs: 6000, accuracyMeters: 3 }).progressMeters)
      .toBeCloseTo(19);
    expect(matcher.match({ position: point(0, 16, 0), timestampMs: 9000, accuracyMeters: 3 }).progressMeters)
      .toBeCloseTo(16);
  });

  it("marks an implausible jump uncertain while preserving the previous match", () => {
    const matcher = new RouteMatcher([point(0, 0, 0), point(0, 200, 200)], 30);
    matcher.match({ position: point(0, 30, 0), timestampMs: 0, accuracyMeters: 5 });
    const match = matcher.match({ position: point(0, 180, 0), timestampMs: 1000, accuracyMeters: 5 });
    expect(match.uncertain).toBe(true);
    expect(match.progressMeters).toBe(30);
  });

  it("does not relocate the calibrated progress prior on the first distant fix", () => {
    const matcher = new RouteMatcher([point(0, 0, 0), point(0, 200, 200)], 0);
    const match = matcher.match({ position: point(0, 100, 0), timestampMs: 1000, accuracyMeters: 5 });
    expect(match.uncertain).toBe(true);
    expect(match.progressMeters).toBe(0);
  });

  it("retains uncertainty when a distant leg is substantially closer than the prior leg", () => {
    const matcher = new RouteMatcher([point(0, 0, 0), point(0, 100, 100), point(20, 100, 120), point(20, 0, 220)], 30);
    matcher.match({ position: point(0, 30, 0), timestampMs: 0, accuracyMeters: 3 });
    const match = matcher.match({ position: point(20, 30, 0), timestampMs: 1000, accuracyMeters: 3 });
    expect(match).toMatchObject({ progressMeters: 30, segmentIndex: 0, uncertain: true });
  });

  it("uses geographic north-clockwise route bearing", () => {
    const matcher = new RouteMatcher([point(0, 0, 0), point(0, 20, 20), point(20, 20, 40)], 20);
    const match = matcher.match({ position: point(0, 20, 0), timestampMs: 0, accuracyMeters: 5 });
    expect(match.routeBearingRad).toBeCloseTo(Math.PI / 2);
  });
});

function point(eastMeters: number, northMeters: number, routeDistanceMeters: number): LocalRoutePoint {
  return { eastMeters, northMeters, upMeters: 0, routeDistanceMeters };
}
