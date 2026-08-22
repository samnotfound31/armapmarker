import { describe, expect, it } from "vitest";
import {
  LANDSCAPE_VIDEO,
  PORTRAIT_SCREEN
} from "../test/geometryFixtures";
import { createDisplayTransform } from "./displayTransform";
import {
  normalizeScreenOrientationAngle,
  resolveDisplayRotation,
  rotateCameraFromGroundForScreen
} from "./displayTransform";
import { applyMat4ToPoint } from "./groundCalibration";
import { IDENTITY_MAT4 } from "../test/geometryFixtures";

describe("createDisplayTransform", () => {
  it("maps the optical centre through a portrait quarter-turn", () => {
    const transform = createDisplayTransform({
      imageWidthPx: LANDSCAPE_VIDEO.widthPx,
      imageHeightPx: LANDSCAPE_VIDEO.heightPx,
      screenWidthPx: PORTRAIT_SCREEN.widthPx,
      screenHeightPx: PORTRAIT_SCREEN.heightPx,
      rotationDeg: 90
    });

    expect(transform.imageToScreenPoint({ xPx: 960, yPx: 540 })).toEqual({
      xPx: 540,
      yPx: 960
    });
  });

  it("round-trips touch and image pixels through object-fit cover", () => {
    const transform = createDisplayTransform({
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      screenWidthPx: 1080,
      screenHeightPx: 1920,
      rotationDeg: 0
    });
    const imagePoint = { xPx: 1110, yPx: 690 };
    const screenPoint = transform.imageToScreenPoint(imagePoint);

    expect(transform.screenToImagePoint(screenPoint)).toEqual({
      xPx: expect.closeTo(1110),
      yPx: expect.closeTo(690)
    });
    expect(transform.scale).toBeCloseTo(1920 / 1080);
  });

  it("maps a landscape optical centre without rotation", () => {
    const transform = createDisplayTransform({
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      screenWidthPx: 1920,
      screenHeightPx: 1080,
      rotationDeg: 0
    });
    expect(transform.imageToScreenPoint({ xPx: 960, yPx: 540 })).toEqual({
      xPx: 960,
      yPx: 540
    });
  });

  it("normalizes both positive and negative screen orientation angles", () => {
    expect(normalizeScreenOrientationAngle(90)).toBe(90);
    expect(normalizeScreenOrientationAngle(-90)).toBe(270);
    expect(normalizeScreenOrientationAngle(450)).toBe(90);
  });

  it("applies the same screen quarter-turn to the sensor camera frame", () => {
    const positive = rotateCameraFromGroundForScreen(IDENTITY_MAT4, 90);
    const negative = rotateCameraFromGroundForScreen(IDENTITY_MAT4, -90);

    expect(applyMat4ToPoint(positive, [1, 0, 2])).toEqual([
      expect.closeTo(0),
      expect.closeTo(1),
      2
    ]);
    expect(applyMat4ToPoint(negative, [1, 0, 2])).toEqual([
      expect.closeTo(0),
      expect.closeTo(-1),
      2
    ]);
  });

  it("prefers actual +90/-90 orientation and falls back to dimension mismatch", () => {
    expect(resolveDisplayRotation(90, 1280, 720, 844, 390)).toBe(90);
    expect(resolveDisplayRotation(-90, 1280, 720, 844, 390)).toBe(270);
    expect(resolveDisplayRotation(0, 1280, 720, 390, 844)).toBe(90);
    expect(resolveDisplayRotation(0, 1280, 720, 844, 390)).toBe(0);
  });
});
