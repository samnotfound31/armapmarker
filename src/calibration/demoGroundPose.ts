import type { CameraIntrinsics, GroundCalibration, Mat3, Mat4, RouteGroundPoint } from "../domain/types";
import type { Vec3 } from "../geometry/intrinsics";
import { sampleRouteGroundPoint } from "../route/prepareRoute";

// The route renderer consumes GroundCalibration, independent of whether the
// ground prior comes from this web estimate, an anchor, or a future pose provider.
export type GroundPoseInput = {
  groundRoute: readonly RouteGroundPoint[];
  progressMeters: number;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  capture: { cameraFromGroundAtLock: Mat4; earthFromGroundAtLock?: Mat3 };
  anchor?: Vec3;
  yawAdjustmentRad?: number;
};

export function estimateDemoGroundPose(input: GroundPoseInput): GroundCalibration {
  const current = sampleRouteGroundPoint(input.groundRoute, input.progressMeters);
  const ahead = sampleRouteGroundPoint(input.groundRoute, input.progressMeters + 2);
  const dx = ahead.rightMeters - current.rightMeters;
  const dz = ahead.forwardMeters - current.forwardMeters;
  if (Math.hypot(dx, dz) < 0.05) throw new RangeError("No ground route remains ahead.");
  const anchor = input.anchor ?? [0, 0, 4];
  const distance = Math.hypot(anchor[0], anchor[2]);
  if (anchor.some((v) => !Number.isFinite(v)) || anchor[2] <= 0 || distance < 0.5 || distance > 20) {
    throw new RangeError("Aim lower and tap visible ground a few metres ahead.");
  }
  // Route tangent is the forward prior. One tap supplies a direction, not an
  // exact metric correspondence or a compass bearing; gravity supplies pitch/roll.
  const yaw = Math.atan2(anchor[0], anchor[2]) - Math.atan2(dx, dz) + (input.yawAdjustmentRad ?? 0);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    stage: "locked", cameraHeightMeters: 1.4, intrinsics: input.intrinsics,
    imageToScreen: input.imageToScreen,
    groundFromRoute: [c,0,-s,0, 0,1,0,0, s,0,c,0,
      -c * current.rightMeters - s * current.forwardMeters,
      -current.upMeters, s * current.rightMeters - c * current.forwardMeters, 1],
    cameraFromGroundAtLock: input.capture.cameraFromGroundAtLock,
    ...(input.capture.earthFromGroundAtLock ? {earthFromGroundAtLock:input.capture.earthFromGroundAtLock} : {}),
    calibrationRouteDistanceMeters: input.progressMeters, lockedAtMs: Date.now()
  };
}
