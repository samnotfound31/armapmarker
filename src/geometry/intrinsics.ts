import type { CameraIntrinsics } from "../domain/types";

export type ImagePixel = { xPx: number; yPx: number };
export type Vec3 = [number, number, number];

export const CALIBRATION_CONFIG = {
  effectiveHorizontalFovDeg: 65,
  cameraHeightPresetsMeters: [1.2, 1.4, 1.6] as const,
  minimumTapSeparationMeters: 2,
  minimumStableOrientationSamples: 5,
  minimumStableScanSamples: 20,
  initialFeatureCount: 30,
  initialInlierCount: 15,
  maximumScanAngularMotionRad: 0.15
} as const;

export function buildApproximateIntrinsics(
  imageWidthPx: number,
  imageHeightPx: number,
  effectiveHorizontalFovDeg: number =
    CALIBRATION_CONFIG.effectiveHorizontalFovDeg
): CameraIntrinsics {
  if (
    !Number.isFinite(imageWidthPx) ||
    !Number.isFinite(imageHeightPx) ||
    imageWidthPx <= 0 ||
    imageHeightPx <= 0
  ) {
    throw new RangeError("Camera image dimensions must be positive.");
  }
  if (
    !Number.isFinite(effectiveHorizontalFovDeg) ||
    effectiveHorizontalFovDeg <= 0 ||
    effectiveHorizontalFovDeg >= 180
  ) {
    throw new RangeError("Effective horizontal FOV must be between 0 and 180 degrees.");
  }

  const fovRad = (effectiveHorizontalFovDeg * Math.PI) / 180;
  const focalLengthPx = imageWidthPx / (2 * Math.tan(fovRad / 2));
  return {
    imageWidthPx,
    imageHeightPx,
    fxPx: focalLengthPx,
    fyPx: focalLengthPx,
    cxPx: imageWidthPx / 2,
    cyPx: imageHeightPx / 2,
    effectiveHorizontalFovDeg,
    source: "assumed-fov"
  };
}

export function imagePixelToCameraRay(
  pixel: ImagePixel,
  intrinsics: CameraIntrinsics
): Vec3 {
  return [
    (pixel.xPx - intrinsics.cxPx) / intrinsics.fxPx,
    (pixel.yPx - intrinsics.cyPx) / intrinsics.fyPx,
    1
  ];
}
