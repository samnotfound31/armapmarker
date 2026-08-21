import { describe, expect, it } from "vitest";
import type { Mat3 } from "../domain/types";
import { IDENTITY_MAT4 } from "../test/geometryFixtures";
import { buildApproximateIntrinsics } from "./intrinsics";
import {
  applyMat4ToPoint,
  averageOrientationSamples,
  buildCameraFromGroundAtLock,
  buildCameraFromGroundWithEarthFrame,
  buildEarthFromGroundAtLock,
  fitRouteToGroundTransform,
  intersectImageRayWithGround,
  intersectRayWithGroundPlane,
  projectGroundPoint
} from "./groundCalibration";

const groundFromCamera: Mat3 = [
  1, 0, 0,
  0, -1, 0,
  0, 0, 1
];

describe("ground intersection", () => {
  it("intersects a downward ray with the metric road plane", () => {
    expect(
      intersectRayWithGroundPlane(
        [0, 1.4, 0],
        [0, -0.5, 1],
        [0, 1, 0],
        0
      )
    ).toEqual([0, 0, 2.8]);
  });

  it("rejects parallel and skyward rays", () => {
    expect(
      intersectRayWithGroundPlane([0, 1.4, 0], [1, 0, 1], [0, 1, 0], 0)
    ).toBeNull();
    expect(
      intersectRayWithGroundPlane([0, 1.4, 0], [0, 1, 1], [0, 1, 0], 0)
    ).toBeNull();
  });

  it("uses camera height and intrinsics without changing metre scale", () => {
    const k = buildApproximateIntrinsics(1920, 1080, 90);
    const point = intersectImageRayWithGround(
      { xPx: 960, yPx: 810 },
      k,
      groundFromCamera,
      [0, 1.4, 0]
    );

    expect(point).toEqual([
      0,
      0,
      expect.closeTo(1.4 / ((810 - 540) / 960))
    ]);
  });
});

describe("route-to-ground fit", () => {
  it("rotates and translates route metres onto the two tapped points", () => {
    const transform = fitRouteToGroundTransform(
      { rightMeters: 0, upMeters: 0, forwardMeters: 3, routeDistanceMeters: 10 },
      [1, 0, 4],
      [3, 0, 4]
    );

    expect(applyMat4ToPoint(transform, [0, 0, 3])).toEqual([
      expect.closeTo(1),
      0,
      expect.closeTo(4)
    ]);
    expect(applyMat4ToPoint(transform, [0, 0, 5])).toEqual([
      expect.closeTo(3),
      0,
      expect.closeTo(4)
    ]);
  });

  it("rejects taps that do not define two horizontal metres", () => {
    expect(() =>
      fitRouteToGroundTransform(
        { rightMeters: 0, upMeters: 0, forwardMeters: 3, routeDistanceMeters: 10 },
        [0, 0, 3],
        [0, 0, 4.9]
      )
    ).toThrow(/two metres/i);
  });
});

describe("projection and orientation averaging", () => {
  it("maps W3C portrait orientation and camera height into camera coordinates", () => {
    const cameraFromGround = buildCameraFromGroundAtLock(
      { alphaRad: 0, betaRad: Math.PI / 2, gammaRad: 0 },
      1.4
    );

    expect(applyMat4ToPoint(cameraFromGround, [0, 0, 5])).toEqual([
      expect.closeTo(0),
      expect.closeTo(1.4),
      expect.closeTo(5)
    ]);
  });

  it("keeps the Earth-ground frame fixed while later yaw changes camera view", () => {
    const lock = { alphaRad: 0, betaRad: Math.PI / 2, gammaRad: 0 };
    const earthFromGround = buildEarthFromGroundAtLock(lock);
    const moved = buildCameraFromGroundWithEarthFrame(
      { ...lock, alphaRad: Math.PI / 2 },
      earthFromGround,
      [0, 1.4, 0]
    );

    expect(applyMat4ToPoint(moved, [0, 0, 5])[0]).not.toBeCloseTo(0);
  });

  it("rejects points behind the camera with a discriminated result", () => {
    const k = buildApproximateIntrinsics(1920, 1080);
    expect(projectGroundPoint([0, 0, -2], IDENTITY_MAT4, k)).toEqual({
      visible: false,
      reason: "behind-camera"
    });
  });

  it("averages headings across north without wrapping to south", () => {
    const average = averageOrientationSamples([
      { headingRad: (359 * Math.PI) / 180, pitchRad: 0.2, rollRad: 0.1 },
      { headingRad: Math.PI / 180, pitchRad: 0.4, rollRad: -0.1 }
    ]);

    expect(Math.min(average.headingRad, Math.PI * 2 - average.headingRad)).toBeLessThan(
      0.001
    );
    expect(average.pitchRad).toBeCloseTo(0.3);
    expect(average.rollRad).toBeCloseTo(0);
  });
});
