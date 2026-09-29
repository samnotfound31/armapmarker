import { describe, expect, it } from "vitest";
import { AcceptedLocationFilter } from "./AcceptedLocationFilter";
import type { LocationFix } from "./location";

const EPOCH = 1_800_000_000_000;

describe("AcceptedLocationFilter", () => {
  it("keeps source time as metadata and exposes a monotonic navigation time", () => {
    const filter = new AcceptedLocationFilter();
    const location = fix(EPOCH - 100, 5);
    const decision = filter.accept(location, EPOCH, 120);

    expect(decision).toMatchObject({ accepted: true, status: "GOOD", timestampMs: 120 });
    expect(decision.fix?.timestampMs).toBe(EPOCH - 100);
    expect(filter.freshness(1120)).toMatchObject({ usable: true, ageMs: 1100 });
  });

  it("rejects inaccurate fixes without replacing the last accepted position", () => {
    const filter = new AcceptedLocationFilter();
    filter.accept(fix(EPOCH, 5), EPOCH, 100);
    expect(filter.accept(fix(EPOCH + 1000, 100), EPOCH + 1000, 1100))
      .toMatchObject({ accepted: false, status: "REJECTED", reason: "accuracy" });
    expect(filter.lastAcceptedFix?.accuracyMeters).toBe(5);
    expect(filter.freshness(1100)).toMatchObject({ usable: false });
  });

  it("downgrades imprecise fixes without accepting them for navigation", () => {
    const filter = new AcceptedLocationFilter();
    expect(filter.accept(fix(EPOCH, 20), EPOCH, 100))
      .toMatchObject({ accepted: false, status: "DEGRADED", reason: "accuracy" });
    expect(filter.lastAcceptedFix).toBeNull();
  });

  it.each([
    { point: { lat: Number.NaN, lng: 0 } },
    { point: { lat: 91, lng: 0 } },
    { point: { lat: 0, lng: 181 } },
    { accuracyMeters: Number.NaN },
    { accuracyMeters: -1 },
    { timestampMs: Number.NaN }
  ])("rejects invalid geolocation fields %#", (change) => {
    const filter = new AcceptedLocationFilter();
    expect(filter.accept({ ...fix(EPOCH, 5), ...change }, EPOCH, 100))
      .toMatchObject({ accepted: false, status: "REJECTED", reason: "invalid" });
  });

  it("rejects stale, future and repeated source timestamps", () => {
    const filter = new AcceptedLocationFilter();
    expect(filter.accept(fix(EPOCH - 5000, 5), EPOCH, 100).reason).toBe("stale");
    expect(filter.accept(fix(EPOCH + 5000, 5), EPOCH, 100).reason).toBe("future");
    filter.accept(fix(EPOCH, 5), EPOCH, 100);
    expect(filter.accept(fix(EPOCH, 5), EPOCH + 1000, 1100).reason).toBe("out-of-order");
    expect(filter.accept(fix(EPOCH - 1, 5), EPOCH + 1000, 1100).reason).toBe("out-of-order");
  });

  it("expires when no usable fix arrives and recovers only on a fresh accepted fix", () => {
    const filter = new AcceptedLocationFilter();
    filter.accept(fix(EPOCH, 15), EPOCH, 100);
    expect(filter.freshness(5099).usable).toBe(true);
    expect(filter.freshness(5101).usable).toBe(false);
    filter.accept(fix(EPOCH + 6000, 5), EPOCH + 6000, 6100);
    expect(filter.freshness(6100)).toMatchObject({ usable: true, ageMs: 0, status: "GOOD" });
  });

  it("includes source age in the freshness watchdog rather than refreshing a cached fix", () => {
    const filter = new AcceptedLocationFilter();
    filter.accept(fix(EPOCH - 2900, 5), EPOCH, 100);
    expect(filter.freshness(2201)).toMatchObject({ usable: false, ageMs: 5001 });
  });
});

function fix(timestampMs: number, accuracyMeters: number): LocationFix {
  return { point: { lat: 20.35, lng: 85.82 }, accuracyMeters, timestampMs };
}
