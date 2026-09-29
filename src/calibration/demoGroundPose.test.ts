import { describe, expect, it } from "vitest";
import { estimateDemoGroundPose } from "./demoGroundPose";
import { applyMat4ToPoint, buildCameraFromGroundWithEarthFrame, GEOGRAPHIC_EARTH_FROM_GROUND } from "../geometry/groundCalibration";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { createDisplayTransform } from "../geometry/displayTransform";
import { projectRoutePointToScreen } from "../ar/projection";
import { PoseFusion } from "../pose/PoseFusion";
import { readAbsoluteCameraHeading } from "../device/orientation";

const route = [{ rightMeters: 0, upMeters: 0, forwardMeters: -10, routeDistanceMeters: 0 },
  { rightMeters: 0, upMeters: 0, forwardMeters: 30, routeDistanceMeters: 40 }];

function inputForHeading(compassDeg = 0) {
  const heading = readAbsoluteCameraHeading({ alpha: 17, beta: 80, gamma: 0,
    webkitCompassHeading: compassDeg, webkitCompassAccuracy: 5 }, 0, 0);
  return {
    groundRoute: route, progressMeters: 10, routeBearingRad: 0,
    intrinsics: buildApproximateIntrinsics(720, 1280),
    imageToScreen: createDisplayTransform({ imageWidthPx: 720, imageHeightPx: 1280,
      screenWidthPx: 390, screenHeightPx: 844, rotationDeg: 0 }).imageToScreen,
    capture: { cameraFromGroundAtLock: buildCameraFromGroundWithEarthFrame(heading.orientation!, GEOGRAPHIC_EARTH_FROM_GROUND, [0, 1.4, 0]),
      earthFromGroundAtLock: GEOGRAPHIC_EARTH_FROM_GROUND, absoluteHeading: heading }
  };
}

describe("geographic ground pose", () => {
  it("projects a northbound route ahead only when the camera actually faces north", () => {
    const north = estimateDemoGroundPose(inputForHeading(0));
    const east = estimateDemoGroundPose(inputForHeading(90));
    const south = estimateDemoGroundPose(inputForHeading(180));
    const point = { rightMeters: 0, upMeters: 0, forwardMeters: 4, routeDistanceMeters: 14 };
    const projection = (pose: typeof north) => projectRoutePointToScreen(point, pose, new PoseFusion(pose).snapshot(0));
    expect(north.geographicYawValidated).toBe(true);
    expect(projection(north)?.xPx).toBeCloseTo(195);
    expect(projection(east)?.xPx).toBeLessThan(0);
    expect(projection(south)).toBeNull();
    expect(east.groundFromRoute).toEqual(north.groundFromRoute);
    expect(south.groundFromRoute).toEqual(north.groundFromRoute);
  });

  it("keeps route geographic yaw unchanged when a ground tap moves sideways", () => {
    const eastAnchor = estimateDemoGroundPose({ ...inputForHeading(), anchor: [4, 0, 4] });
    const westAnchor = estimateDemoGroundPose({ ...inputForHeading(), anchor: [-4, 0, 4] });
    expect(eastAnchor.groundFromRoute).toEqual(westAnchor.groundFromRoute);
    expect(applyMat4ToPoint(eastAnchor.groundFromRoute, [0, 0, 4])).toEqual([0, 0, 4]);
  });

  it("preserves actual lateral position instead of centering the camera on matched route progress", () => {
    const pose = estimateDemoGroundPose({ ...inputForHeading(),
      actualRoutePosition: { rightMeters: 10, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 10 } });
    expect(applyMat4ToPoint(pose.groundFromRoute, [0, 0, 4])).toEqual([-10, 0, 4]);
    expect(new PoseFusion(pose).snapshot(0).cameraPositionGroundMeters).toEqual([0, 1.4, 0]);
  });

  it("keeps an eastbound bend east in the north-anchored route frame", () => {
    const bent = [{ rightMeters: 10, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 10 },
      { rightMeters: 30, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 30 }];
    const pose = estimateDemoGroundPose({ ...inputForHeading(), groundRoute: bent, routeBearingRad: 0 });
    expect(applyMat4ToPoint(pose.groundFromRoute, [14, 0, 0])).toEqual([expect.closeTo(4), 0, expect.closeTo(0)]);
  });

  it("preserves geographic yaw when initial progress is exactly on a sharp corner", () => {
    const bent = [
      { rightMeters: 0, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 0 },
      { rightMeters: 0, upMeters: 0, forwardMeters: 20, routeDistanceMeters: 20 },
      { rightMeters: 20, upMeters: 0, forwardMeters: 20, routeDistanceMeters: 40 }
    ];
    const pose = estimateDemoGroundPose({ ...inputForHeading(), groundRoute: bent, progressMeters: 20, routeBearingRad: 0 });
    expect(applyMat4ToPoint(pose.groundFromRoute, [4, 0, 20])).toEqual([4, 0, 0]);
    expect(applyMat4ToPoint(pose.groundFromRoute, [0, 0, 16])).toEqual([0, 0, -4]);
  });

  it("keeps a two-dimensional route on the ground when GPS supplies altitude", () => {
    const pose = estimateDemoGroundPose({ ...inputForHeading(), actualRoutePosition: {
      rightMeters: 0, upMeters: 42, forwardMeters: 0, routeDistanceMeters: 10
    } });
    expect(applyMat4ToPoint(pose.groundFromRoute, [0, 0, 4])).toEqual([0, 0, 4]);
    expect(new PoseFusion(pose).snapshot(0).cameraPositionGroundMeters[1]).toBe(1.4);
  });

  it("never claims geographic lock with unavailable heading or missing route bearing", () => {
    const input = inputForHeading();
    const noHeading = estimateDemoGroundPose({ ...input, capture: { ...input.capture,
      absoluteHeading: { ...input.capture.absoluteHeading, headingRad: null, usable: false, reason: "unavailable" } } });
    const noBearing = estimateDemoGroundPose({ ...input, routeBearingRad: undefined });
    expect(noHeading.geographicYawValidated).toBe(false);
    expect(noBearing.geographicYawValidated).toBe(false);
  });

  it("requires the captured camera frame to agree with the absolute heading", () => {
    const east = inputForHeading(90);
    const noFixedFrame = estimateDemoGroundPose({ ...east, capture: { ...east.capture, earthFromGroundAtLock: undefined } });
    const inconsistentCamera = estimateDemoGroundPose({ ...east,
      capture: { ...east.capture, cameraFromGroundAtLock: inputForHeading(0).capture.cameraFromGroundAtLock } });
    expect(noFixedFrame.geographicYawValidated).toBe(false);
    expect(inconsistentCamera.geographicYawValidated).toBe(false);
  });

  it("limits explicit yaw corrections and rejects invalid ground anchors", () => {
    expect(() => estimateDemoGroundPose({ ...inputForHeading(), yawAdjustmentRad: Math.PI / 2 })).toThrow(/correction/i);
    for (const anchor of [[0, 0, 100], [NaN, 0, 3], [0, 0, 0.1]] as [number, number, number][]) {
      expect(() => estimateDemoGroundPose({ ...inputForHeading(), anchor })).toThrow(/ground/i);
    }
    // A south-facing camera can tap south ground; geographic Z is not camera forward.
    expect(() => estimateDemoGroundPose({ ...inputForHeading(180), anchor: [0, 0, -4] })).not.toThrow();
  });
});
