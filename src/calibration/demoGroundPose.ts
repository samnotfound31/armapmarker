import type { CameraIntrinsics, GroundCalibration, Mat3, Mat4, RouteGroundPoint } from "../domain/types";
import type { Vec3 } from "../geometry/intrinsics";
import { sampleRouteGroundPoint } from "../route/prepareRoute";
import type { AbsoluteHeadingReading } from "../device/orientation";
import { GEOGRAPHIC_EARTH_FROM_GROUND } from "../geometry/groundCalibration";

export const GROUND_POSE_CONFIG = {
  cameraHeightMeters: 1.4 as const,
  maximumYawCorrectionRad: 5 * Math.PI / 180
};

// The route renderer consumes GroundCalibration, independent of whether the
// ground prior comes from this web estimate, an anchor, or a future pose provider.
export type GroundPoseInput = {
  groundRoute: readonly RouteGroundPoint[];
  progressMeters: number;
  /** Geographic bearing of the prepared route frame's +forward axis, clockwise true north. */
  routeBearingRad?: number;
  /** Actual accepted GPS position in the same route-local frame as groundRoute. */
  actualRoutePosition?: RouteGroundPoint;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  capture: { cameraFromGroundAtLock: Mat4; earthFromGroundAtLock?: Mat3; absoluteHeading?: AbsoluteHeadingReading };
  anchor?: Vec3;
  yawAdjustmentRad?: number;
  cameraHeightMeters?: 1.2 | 1.4 | 1.6;
};

export function estimateDemoGroundPose(input: GroundPoseInput): GroundCalibration {
  const current = sampleRouteGroundPoint(input.groundRoute, input.progressMeters);
  if (input.anchor) {
    const distance = Math.hypot(input.anchor[0], input.anchor[2]);
    if (input.anchor.some((v) => !Number.isFinite(v)) || distance < 0.5 || distance > 20) {
      throw new RangeError("Aim lower and tap visible ground a few metres ahead.");
    }
  }
  const correction = input.yawAdjustmentRad ?? 0;
  if (!Number.isFinite(correction) || Math.abs(correction) > GROUND_POSE_CONFIG.maximumYawCorrectionRad) {
    throw new RangeError("Ground alignment correction must stay within five degrees.");
  }
  if (input.routeBearingRad !== undefined && !Number.isFinite(input.routeBearingRad)) {
    throw new RangeError("Route geographic bearing must be finite.");
  }
  const actual = input.actualRoutePosition ?? current;
  if ([actual.rightMeters, actual.upMeters, actual.forwardMeters].some((v) => !Number.isFinite(v))) {
    throw new RangeError("Actual ground position must be finite.");
  }
  // PreparedRoute already expresses every route point in its fixed route frame.
  // Its bearing is the geographic bearing of that frame's +forward axis, even
  // when the current position lies on a bend. Never derive a new yaw from the
  // next marker: that would rotate the entire route toward the next segment.
  const yaw = (input.routeBearingRad ?? 0) + correction;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const heading = input.capture.absoluteHeading;
  const fixedEarthFrame = input.capture.earthFromGroundAtLock?.every((value, index) =>
    Math.abs(value - GEOGRAPHIC_EARTH_FROM_GROUND[index]!) < 1e-6) === true;
  const camera = input.capture.cameraFromGroundAtLock;
  const horizontalCameraForward = Math.hypot(camera[2], camera[10]);
  const cameraBearing = Math.atan2(camera[2], camera[10]);
  const cameraMatchesHeading = heading?.headingRad !== null && heading?.headingRad !== undefined &&
    camera.every(Number.isFinite) && horizontalCameraForward >= 0.15 &&
    Math.abs(Math.atan2(Math.sin(cameraBearing - heading.headingRad),
      Math.cos(cameraBearing - heading.headingRad))) <= Math.PI / 180;
  const geographicYawValidated = input.routeBearingRad !== undefined &&
    heading?.usable === true && fixedEarthFrame && cameraMatchesHeading;
  return {
    stage: "locked", cameraHeightMeters: input.cameraHeightMeters ?? GROUND_POSE_CONFIG.cameraHeightMeters, intrinsics: input.intrinsics,
    imageToScreen: input.imageToScreen,
    groundFromRoute: [c,0,-s,0, 0,1,0,0, s,0,c,0,
      -c * actual.rightMeters - s * actual.forwardMeters,
      // GPS altitude is source metadata, not a ground-height measurement. A
      // two-dimensional provider route and an altitude-bearing fix may differ
      // by tens of metres. Keep the route at its own current ground plane.
      -current.upMeters, s * actual.rightMeters - c * actual.forwardMeters, 1],
    cameraFromGroundAtLock: input.capture.cameraFromGroundAtLock,
    ...(input.capture.earthFromGroundAtLock ? {earthFromGroundAtLock:input.capture.earthFromGroundAtLock} : {}),
    geographicYawValidated,
    ...(input.capture.absoluteHeading ? { absoluteHeading: input.capture.absoluteHeading } : {}),
    calibrationRouteDistanceMeters: input.progressMeters, lockedAtMs: performance.now()
  };
}
