import { describe, expect, it } from "vitest";
import { estimateDemoGroundPose } from "./demoGroundPose";
import { buildCameraFromGroundAtLock, buildEarthFromGroundAtLock, applyMat4ToPoint } from "../geometry/groundCalibration";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { createDisplayTransform } from "../geometry/displayTransform";
import { projectRoutePointToScreen } from "../ar/projection";
import { PoseFusion } from "../pose/PoseFusion";

const orientation = { alphaRad: 0.7, betaRad: 1.2, gammaRad: 0 };
const route = [{ rightMeters: 0, upMeters: 0, forwardMeters: -10, routeDistanceMeters: 0 },
  { rightMeters: 0, upMeters: 0, forwardMeters: 30, routeDistanceMeters: 40 }];
const input = {
  groundRoute: route, progressMeters: 10,
  intrinsics: buildApproximateIntrinsics(720, 1280),
  imageToScreen: createDisplayTransform({ imageWidthPx: 720, imageHeightPx: 1280,
    screenWidthPx: 390, screenHeightPx: 844, rotationDeg: 0 }).imageToScreen,
  capture: { cameraFromGroundAtLock: buildCameraFromGroundAtLock(orientation, 1.4),
    earthFromGroundAtLock: buildEarthFromGroundAtLock(orientation) }
};
describe("demo ground pose", () => {
  it("uses a default height and a forward route prior with visible portrait markers", () => {
    const calibration = estimateDemoGroundPose(input);
    expect(calibration.cameraHeightMeters).toBe(1.4);
    const point = projectRoutePointToScreen({rightMeters: 0, upMeters: 0, forwardMeters: 4, routeDistanceMeters: 14},
      calibration, new PoseFusion(calibration).snapshot(0));
    expect(point).not.toBeNull();
    expect(point!.xPx).toBeGreaterThan(0);
    expect(point!.xPx).toBeLessThan(390);
    expect(point!.yPx).toBeGreaterThan(0);
    expect(point!.yPx).toBeLessThan(844);
  });
  it("one anchor adjusts direction without depending on an exact tapped distance", () => {
    const near = estimateDemoGroundPose({...input, anchor: [1, 0, 4]});
    const far = estimateDemoGroundPose({...input, anchor: [2, 0, 8]});
    expect(near.groundFromRoute).toEqual(far.groundFromRoute);
    const ahead = applyMat4ToPoint(near.groundFromRoute, [0, 0, 4]);
    expect(ahead[0]).toBeGreaterThan(0);
    expect(ahead[2]).toBeGreaterThan(0);
  });
  it("aligns the local route tangent and anchors progress at the camera, including a bend", () => {
    const bent = [{ rightMeters: 10, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 10 },
      { rightMeters: 30, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 30 }];
    const pose = estimateDemoGroundPose({...input, groundRoute: bent});
    expect(applyMat4ToPoint(pose.groundFromRoute, [10,0,0])).toEqual([expect.closeTo(0),0,expect.closeTo(0)]);
    expect(applyMat4ToPoint(pose.groundFromRoute, [14,0,0])).toEqual([expect.closeTo(0),0,expect.closeTo(4)]);
  });
  it("rejects anchors behind the user, at the horizon, or non-finite", () => {
    for (const anchor of [[0,0,-3], [0,0,100], [NaN,0,3]] as [number,number,number][]) {
      expect(() => estimateDemoGroundPose({...input, anchor})).toThrow(/ground/i);
    }
  });
});
