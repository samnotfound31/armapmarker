import { describe, expect, it } from "vitest";
import {
  normalizeDeviceOrientation,
  readCompassHeading,
  readAbsoluteCameraHeading
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

  it("does not fall back to alpha when Safari explicitly disowns its compass", () => {
    expect(readCompassHeading({ alpha: 90, absolute: true, webkitCompassHeading: -1, webkitCompassAccuracy: 5 })).toBeUndefined();
    expect(readCompassHeading({ alpha: 90, absolute: true, webkitCompassHeading: 20, webkitCompassAccuracy: -1 })).toBeUndefined();
  });
});

describe("absolute rear-camera heading", () => {
  it.each([
    { compass: 0, expected: 0 },
    { compass: 90, expected: Math.PI / 2 },
    { compass: 180, expected: Math.PI },
    { compass: 270, expected: Math.PI * 1.5 }
  ])("anchors portrait rear camera at $compass degrees instead of relative alpha", ({ compass, expected }) => {
    const reading = readAbsoluteCameraHeading({
      alpha: 123, beta: 80, gamma: 0, absolute: false,
      webkitCompassHeading: compass, webkitCompassAccuracy: 6
    }, 100, 0);
    expect(reading.usable).toBe(true);
    expect(reading.headingRad).toBeCloseTo(expected);
    expect(reading.orientation?.alphaRad).not.toBeCloseTo(123 * Math.PI / 180);
  });

  it("derives landscape rear-camera bearing from tilt rather than screen-top heading", () => {
    const reading = readAbsoluteCameraHeading({
      alpha: 0, beta: 0, gamma: -80,
      webkitCompassHeading: 0, webkitCompassAccuracy: 5
    }, 100, 0);
    expect(reading.usable).toBe(true);
    expect(reading.headingRad).toBeCloseTo(Math.PI / 2);
  });

  it("rejects WebKit compass azimuth when the device top is nearly vertical", () => {
    const reading = readAbsoluteCameraHeading({
      alpha: 0, beta: 90, gamma: 0,
      webkitCompassHeading: 0, webkitCompassAccuracy: 5
    }, 100, 0);
    expect(reading.usable).toBe(false);
    expect(reading.reason).toBe("compass-reference-vertical");
  });

  it("flips the device-top bearing after pitching past vertical so the rear camera remains north", () => {
    const reading = readAbsoluteCameraHeading({
      alpha: 0, beta: 110, gamma: 0,
      webkitCompassHeading: 180, webkitCompassAccuracy: 5
    }, 100, 0);
    expect(reading.usable).toBe(true);
    expect(reading.headingRad).toBeCloseTo(0);
  });

  it("corrects magnetic north using an explicit declination", () => {
    const reading = readAbsoluteCameraHeading({
      alpha: 0, beta: 80, gamma: 0,
      webkitCompassHeading: 90, webkitCompassAccuracy: 5
    }, 100, 10);
    expect(reading.usable).toBe(true);
    expect(reading.headingRad).toBeCloseTo(100 * Math.PI / 180);
  });

  it("requires a true-north correction instead of guessing magnetic north is geographic north", () => {
    const reading = readAbsoluteCameraHeading({
      alpha: 0, beta: 80, gamma: 0,
      webkitCompassHeading: 0, webkitCompassAccuracy: 5
    }, 100);
    expect(reading.usable).toBe(false);
    expect(reading.reason).toBe("declination-unavailable");
  });

  it.each([
    { alpha: 0, beta: 80, gamma: 0, absolute: false },
    { alpha: 0, beta: 80, gamma: 0, webkitCompassHeading: -1, webkitCompassAccuracy: 5 },
    { alpha: 0, beta: 80, gamma: 0, webkitCompassHeading: 0, webkitCompassAccuracy: -1 },
    { alpha: 0, beta: 80, gamma: 0, webkitCompassHeading: 0, webkitCompassAccuracy: 60 },
    { alpha: 0, beta: 0, gamma: 0, absolute: true },
    { alpha: NaN, beta: 80, gamma: 0, absolute: true },
    { alpha: -1, beta: 80, gamma: 0, webkitCompassHeading: 0, webkitCompassAccuracy: 5 },
    { alpha: 0, beta: null, gamma: 0, absolute: true }
  ])("rejects unavailable, disowned, inaccurate, or vertical camera readings: %j", (event) => {
    expect(readAbsoluteCameraHeading(event, 100, 0).usable).toBe(false);
  });

  it("uses absolute W3C orientation and rejects unqualified relative alpha", () => {
    const event = { alpha: 270, beta: 80, gamma: 0, absolute: true };
    expect(readAbsoluteCameraHeading(event, 100, 0, { unreportedAccuracyDeg: 10 }).headingRad).toBeCloseTo(Math.PI / 2);
    expect(readAbsoluteCameraHeading({ ...event, absolute: false }, 100, 0).usable).toBe(false);
  });

  it("withholds geographic guidance when compass accuracy is unreported", () => {
    expect(readAbsoluteCameraHeading({ alpha: 270, beta: 80, gamma: 0, absolute: true }, 100, 0).usable).toBe(false);
    expect(readAbsoluteCameraHeading({ alpha: 0, beta: 80, gamma: 0, webkitCompassHeading: 0 }, 100, 0).usable).toBe(false);
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
