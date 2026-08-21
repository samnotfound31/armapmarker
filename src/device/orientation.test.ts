import { describe, expect, it } from "vitest";
import {
  normalizeDeviceOrientation,
  readCompassHeading
} from "./orientation";

describe("readCompassHeading", () => {
  it("converts webkit compass heading into clockwise radians", () => {
    expect(readCompassHeading({ webkitCompassHeading: 90 })).toBeCloseTo(
      Math.PI / 2
    );
  });

  it("converts absolute alpha into clockwise compass radians", () => {
    expect(readCompassHeading({ alpha: 90, absolute: true })).toBeCloseTo(
      (3 * Math.PI) / 2
    );
  });

  it("leaves heading unavailable for a relative alpha sample", () => {
    expect(readCompassHeading({ alpha: 90, absolute: false })).toBeUndefined();
  });
});

describe("normalizeDeviceOrientation", () => {
  it("normalizes pitch, roll, heading, timestamp, and WebKit accuracy", () => {
    expect(
      normalizeDeviceOrientation(
        {
          alpha: 270,
          beta: 30,
          gamma: -15,
          absolute: true,
          webkitCompassHeading: 92,
          webkitCompassAccuracy: 7
        },
        1234
      )
    ).toEqual({
      timestampMs: 1234,
      headingRad: expect.closeTo((92 * Math.PI) / 180),
      pitchRad: expect.closeTo(Math.PI / 6),
      rollRad: expect.closeTo(-Math.PI / 12),
      headingAccuracyDeg: 7,
      headingSource: "webkit-compass"
    });
  });
});
