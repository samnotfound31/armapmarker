import type {
  GroundCalibration,
  Mat3,
  PoseEstimate,
  RouteGroundPoint
} from "../domain/types";
import {
  applyMat4ToPoint,
  projectGroundPoint
} from "../geometry/groundCalibration";

export type ScreenProjection = {
  xPx: number;
  yPx: number;
  cameraDepthMeters: number;
};

export function projectRoutePointToScreen(
  routePoint: RouteGroundPoint,
  calibration: GroundCalibration,
  pose: PoseEstimate
): ScreenProjection | null {
  const groundPoint = applyMat4ToPoint(calibration.groundFromRoute, [
    routePoint.rightMeters,
    routePoint.upMeters,
    routePoint.forwardMeters
  ]);
  const imageProjection = projectGroundPoint(
    groundPoint,
    pose.cameraFromGround,
    calibration.intrinsics
  );
  if (!imageProjection.visible) return null;

  const correctedImage = applyPixelHomography(
    pose.visualCorrection.imageHomography,
    imageProjection.imagePixel.xPx,
    imageProjection.imagePixel.yPx
  );
  if (!correctedImage) return null;
  const screen = applyPixelHomography(
    calibration.imageToScreen,
    correctedImage.xPx,
    correctedImage.yPx
  );
  if (!screen) return null;
  return {
    xPx: screen.xPx,
    yPx: screen.yPx,
    cameraDepthMeters: imageProjection.cameraDepthMeters
  };
}

export function applyPixelHomography(
  matrix: Mat3,
  xPx: number,
  yPx: number
): { xPx: number; yPx: number } | null {
  const divisor = matrix[2] * xPx + matrix[5] * yPx + matrix[8];
  if (!Number.isFinite(divisor) || Math.abs(divisor) <= 1e-9) return null;
  const x = (matrix[0] * xPx + matrix[3] * yPx + matrix[6]) / divisor;
  const y = (matrix[1] * xPx + matrix[4] * yPx + matrix[7]) / divisor;
  return Number.isFinite(x) && Number.isFinite(y) ? { xPx: x, yPx: y } : null;
}
