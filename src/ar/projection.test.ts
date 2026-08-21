import { describe, expect, it } from "vitest";
import type { GroundCalibration, PoseEstimate, RouteGroundPoint } from "../domain/types";
import { createDisplayTransform } from "../geometry/displayTransform";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import { projectRoutePointToScreen } from "./projection";

describe("projectRoutePointToScreen", () => {
  it("projects a known route-local ground point through calibration", () => {
    const result = projectRoutePointToScreen(
      routePoint(0, 10),
      calibration(IDENTITY_MAT3),
      pose()
    );

    expect(result).toEqual({ xPx: 50, yPx: 50, cameraDepthMeters: 10 });
  });

  it("removes a point behind the camera", () => {
    expect(
      projectRoutePointToScreen(
        routePoint(0, -1),
        calibration(IDENTITY_MAT3),
        pose()
      )
    ).toBeNull();
  });

  it("keeps portrait rotation and object-fit cover in the shared display transform", () => {
    const display = createDisplayTransform({
      imageWidthPx: 1920,
      imageHeightPx: 1080,
      screenWidthPx: 1080,
      screenHeightPx: 1920,
      rotationDeg: 90
    });
    const testCalibration: GroundCalibration = {
      ...calibration(display.imageToScreen),
      intrinsics: buildApproximateIntrinsics(1920, 1080, 90)
    };

    const result = projectRoutePointToScreen(routePoint(0, 10), testCalibration, pose());
    expect(result).toMatchObject({ xPx: expect.closeTo(540), yPx: expect.closeTo(960) });
  });

  it("applies visual residual in image space without changing route geometry", () => {
    const point = routePoint(0, 10);
    const original = { ...point };
    const correctedPose = pose([1, 0, 0, 0, 1, 0, 10, -5, 1]);

    expect(
      projectRoutePointToScreen(point, calibration(IDENTITY_MAT3), correctedPose)
    ).toMatchObject({ xPx: 60, yPx: 45 });
    expect(point).toEqual(original);
  });
});

function routePoint(rightMeters: number, forwardMeters: number): RouteGroundPoint {
  return { rightMeters, upMeters: 0, forwardMeters, routeDistanceMeters: forwardMeters };
}

function calibration(imageToScreen: GroundCalibration["imageToScreen"]): GroundCalibration {
  return {
    stage: "locked",
    cameraHeightMeters: 1.4,
    intrinsics: buildApproximateIntrinsics(100, 100, 90),
    imageToScreen,
    groundFromRoute: IDENTITY_MAT4,
    cameraFromGroundAtLock: IDENTITY_MAT4,
    calibrationRouteDistanceMeters: 0,
    lockedAtMs: 1
  };
}

function pose(imageHomography: PoseEstimate["visualCorrection"]["imageHomography"] = IDENTITY_MAT3): PoseEstimate {
  return {
    cameraPositionGroundMeters: [0, 1.4, 0],
    orientationQuaternion: [0, 0, 0, 1],
    cameraFromGround: IDENTITY_MAT4,
    visualCorrection: { imageHomography, keyframeId: 1, timestampMs: 1 },
    routeProgressMeters: 0,
    quality: {
      state: "locked",
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    },
    timestampMs: 1
  };
}
