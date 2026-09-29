import { describe, expect, it } from "vitest";
import { magneticDeclinationForLocation } from "./magneticDeclination";

describe("offline true-north correction", () => {
  it("uses WMM2025 for the campus date without assuming zero declination", () => {
    const result = magneticDeclinationForLocation({lat:20.353,lng:85.819}, Date.UTC(2026,8,29));
    expect(result).toBeTypeOf("number");
    expect(Math.abs(result!)).toBeGreaterThan(0.05);
    expect(Math.abs(result!)).toBeLessThan(10);
  });
  it("withholds a correction outside model validity or sane coordinates", () => {
    expect(magneticDeclinationForLocation({lat:20,lng:85},Date.UTC(2031,0,1))).toBeUndefined();
    expect(magneticDeclinationForLocation({lat:NaN,lng:85},Date.UTC(2026,0,1))).toBeUndefined();
    expect(magneticDeclinationForLocation({lat:91,lng:85},Date.UTC(2026,0,1))).toBeUndefined();
  });
});
