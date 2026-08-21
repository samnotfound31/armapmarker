import type {
  CameraIntrinsics,
  Mat3,
  Mat4,
  RouteGroundPoint
} from "../domain/types";
import {
  CALIBRATION_CONFIG,
  imagePixelToCameraRay,
  type ImagePixel,
  type Vec3
} from "./intrinsics";

const EPSILON = 1e-9;

export type OrientationCalibrationSample = {
  headingRad: number;
  pitchRad: number;
  rollRad: number;
};

export type W3cDeviceOrientation = {
  alphaRad: number;
  betaRad: number;
  gammaRad: number;
};

export type GroundProjection =
  | { visible: false; reason: "behind-camera" | "non-finite" }
  | {
      visible: true;
      imagePixel: ImagePixel;
      insideImage: boolean;
      cameraDepthMeters: number;
    };

export function intersectRayWithGroundPlane(
  cameraOriginGround: Vec3,
  rayDirectionGround: Vec3,
  planeNormalGround: Vec3 = [0, 1, 0],
  planeD = 0
): Vec3 | null {
  const denominator = dot(planeNormalGround, rayDirectionGround);
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= EPSILON) {
    return null;
  }
  const distance =
    -(dot(planeNormalGround, cameraOriginGround) + planeD) / denominator;
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const point: Vec3 = [
    cameraOriginGround[0] + rayDirectionGround[0] * distance,
    cameraOriginGround[1] + rayDirectionGround[1] * distance,
    cameraOriginGround[2] + rayDirectionGround[2] * distance
  ];
  return point.map((component) =>
    Math.abs(component) < EPSILON ? 0 : component
  ) as Vec3;
}

export function intersectImageRayWithGround(
  imagePixel: ImagePixel,
  intrinsics: CameraIntrinsics,
  groundFromCamera: Mat3,
  cameraOriginGround: Vec3
): Vec3 | null {
  const cameraRay = imagePixelToCameraRay(imagePixel, intrinsics);
  const groundRay = applyMat3ToDirection(groundFromCamera, cameraRay);
  return intersectRayWithGroundPlane(cameraOriginGround, groundRay);
}

export function fitRouteToGroundTransform(
  routeNear: RouteGroundPoint,
  groundNear: Vec3,
  groundFar: Vec3
): Mat4 {
  const directionX = groundFar[0] - groundNear[0];
  const directionZ = groundFar[2] - groundNear[2];
  const horizontalDistance = Math.hypot(directionX, directionZ);
  if (horizontalDistance < CALIBRATION_CONFIG.minimumTapSeparationMeters) {
    throw new RangeError("The far tap must be at least two metres beyond the near tap.");
  }

  const sinYaw = directionX / horizontalDistance;
  const cosYaw = directionZ / horizontalDistance;
  const rotatedNear: Vec3 = [
    cosYaw * routeNear.rightMeters + sinYaw * routeNear.forwardMeters,
    routeNear.upMeters,
    -sinYaw * routeNear.rightMeters + cosYaw * routeNear.forwardMeters
  ];
  const translation: Vec3 = [
    groundNear[0] - rotatedNear[0],
    groundNear[1] - rotatedNear[1],
    groundNear[2] - rotatedNear[2]
  ];

  return [
    cosYaw, 0, -sinYaw, 0,
    0, 1, 0, 0,
    sinYaw, 0, cosYaw, 0,
    translation[0], translation[1], translation[2], 1
  ];
}

export function buildCameraFromGroundAtLock(
  orientation: W3cDeviceOrientation,
  cameraHeightMeters: number
): Mat4 {
  if (!Number.isFinite(cameraHeightMeters) || cameraHeightMeters <= 0) {
    throw new RangeError("Camera height must be positive.");
  }
  const earthFromGround = buildEarthFromGroundAtLock(orientation);
  return buildCameraFromGroundWithEarthFrame(
    orientation,
    earthFromGround,
    [0, cameraHeightMeters, 0]
  );
}

export function buildEarthFromGroundAtLock(
  orientation: W3cDeviceOrientation
): Mat3 {
  const { cameraForwardEarth } = cameraAxesInEarth(orientation);
  const horizontalForwardLength = Math.hypot(
    cameraForwardEarth[0],
    cameraForwardEarth[1]
  );
  if (horizontalForwardLength <= EPSILON) {
    throw new RangeError("Point the rear camera toward the horizon before calibration.");
  }
  const groundForwardEarth: Vec3 = [
    cameraForwardEarth[0] / horizontalForwardLength,
    cameraForwardEarth[1] / horizontalForwardLength,
    0
  ];
  const groundUpEarth: Vec3 = [0, 0, 1];
  const groundRightEarth: Vec3 = [
    groundForwardEarth[1],
    -groundForwardEarth[0],
    0
  ];
  return [
    ...groundRightEarth,
    ...groundUpEarth,
    ...groundForwardEarth
  ];
}

export function buildCameraFromGroundWithEarthFrame(
  orientation: W3cDeviceOrientation,
  earthFromGround: Mat3,
  cameraPositionGround: Vec3
): Mat4 {
  if (
    earthFromGround.some((value) => !Number.isFinite(value)) ||
    cameraPositionGround.some((value) => !Number.isFinite(value))
  ) {
    throw new RangeError("Orientation frame and camera position must be finite.");
  }
  const { cameraRightEarth, cameraDownEarth, cameraForwardEarth } =
    cameraAxesInEarth(orientation);
  const groundRightEarth: Vec3 = [
    earthFromGround[0],
    earthFromGround[1],
    earthFromGround[2]
  ];
  const groundUpEarth: Vec3 = [
    earthFromGround[3],
    earthFromGround[4],
    earthFromGround[5]
  ];
  const groundForwardEarth: Vec3 = [
    earthFromGround[6],
    earthFromGround[7],
    earthFromGround[8]
  ];
  const deviceRightEarth: Vec3 = [
    cameraRightEarth[0],
    cameraRightEarth[1],
    cameraRightEarth[2]
  ];
  const toGround = (earthVector: Vec3): Vec3 => [
    dot(groundRightEarth, earthVector),
    dot(groundUpEarth, earthVector),
    dot(groundForwardEarth, earthVector)
  ];
  const cameraRightGround = toGround(deviceRightEarth);
  const cameraDownGround = toGround(cameraDownEarth);
  const cameraForwardGround = toGround(cameraForwardEarth);
  const groundFromCamera: Mat3 = [
    ...cameraRightGround,
    ...cameraDownGround,
    ...cameraForwardGround
  ];
  const cameraFromGround: Mat3 = [
    groundFromCamera[0], groundFromCamera[3], groundFromCamera[6],
    groundFromCamera[1], groundFromCamera[4], groundFromCamera[7],
    groundFromCamera[2], groundFromCamera[5], groundFromCamera[8]
  ];
  const translation: Vec3 = [
    -(cameraFromGround[0] * cameraPositionGround[0] +
      cameraFromGround[3] * cameraPositionGround[1] +
      cameraFromGround[6] * cameraPositionGround[2]),
    -(cameraFromGround[1] * cameraPositionGround[0] +
      cameraFromGround[4] * cameraPositionGround[1] +
      cameraFromGround[7] * cameraPositionGround[2]),
    -(cameraFromGround[2] * cameraPositionGround[0] +
      cameraFromGround[5] * cameraPositionGround[1] +
      cameraFromGround[8] * cameraPositionGround[2])
  ];
  return [
    cameraFromGround[0], cameraFromGround[1], cameraFromGround[2], 0,
    cameraFromGround[3], cameraFromGround[4], cameraFromGround[5], 0,
    cameraFromGround[6], cameraFromGround[7], cameraFromGround[8], 0,
    translation[0], translation[1], translation[2], 1
  ];
}

function cameraAxesInEarth(orientation: W3cDeviceOrientation): {
  cameraRightEarth: Vec3;
  cameraDownEarth: Vec3;
  cameraForwardEarth: Vec3;
} {
  const deviceToEarth = w3cDeviceToEarthRotation(orientation);
  const cameraRightEarth: Vec3 = [
    deviceToEarth[0],
    deviceToEarth[1],
    deviceToEarth[2]
  ];
  const deviceTopEarth: Vec3 = [
    deviceToEarth[3],
    deviceToEarth[4],
    deviceToEarth[5]
  ];
  const deviceFrontEarth: Vec3 = [
    deviceToEarth[6],
    deviceToEarth[7],
    deviceToEarth[8]
  ];
  return {
    cameraRightEarth,
    cameraDownEarth: negate(deviceTopEarth),
    cameraForwardEarth: negate(deviceFrontEarth)
  };
}

export function projectGroundPoint(
  groundPoint: Vec3,
  cameraFromGround: Mat4,
  intrinsics: CameraIntrinsics
): GroundProjection {
  const cameraPoint = applyMat4ToPoint(cameraFromGround, groundPoint);
  if (cameraPoint.some((component) => !Number.isFinite(component))) {
    return { visible: false, reason: "non-finite" };
  }
  if (cameraPoint[2] <= EPSILON) {
    return { visible: false, reason: "behind-camera" };
  }

  const imagePixel = {
    xPx: intrinsics.fxPx * (cameraPoint[0] / cameraPoint[2]) + intrinsics.cxPx,
    yPx: intrinsics.fyPx * (cameraPoint[1] / cameraPoint[2]) + intrinsics.cyPx
  };
  return {
    visible: true,
    imagePixel,
    insideImage:
      imagePixel.xPx >= 0 &&
      imagePixel.xPx <= intrinsics.imageWidthPx &&
      imagePixel.yPx >= 0 &&
      imagePixel.yPx <= intrinsics.imageHeightPx,
    cameraDepthMeters: cameraPoint[2]
  };
}

export function applyMat4ToPoint(matrix: Mat4, point: Vec3): Vec3 {
  const homogeneous =
    matrix[3] * point[0] +
    matrix[7] * point[1] +
    matrix[11] * point[2] +
    matrix[15];
  return [
    (matrix[0] * point[0] +
      matrix[4] * point[1] +
      matrix[8] * point[2] +
      matrix[12]) /
      homogeneous,
    (matrix[1] * point[0] +
      matrix[5] * point[1] +
      matrix[9] * point[2] +
      matrix[13]) /
      homogeneous,
    (matrix[2] * point[0] +
      matrix[6] * point[1] +
      matrix[10] * point[2] +
      matrix[14]) /
      homogeneous
  ];
}

export function averageOrientationSamples(
  samples: readonly OrientationCalibrationSample[]
): OrientationCalibrationSample {
  if (samples.length === 0) {
    throw new RangeError("At least one orientation sample is required.");
  }
  const headingSin = average(samples.map((sample) => Math.sin(sample.headingRad)));
  const headingCos = average(samples.map((sample) => Math.cos(sample.headingRad)));
  const heading = Math.atan2(headingSin, headingCos);
  return {
    headingRad: heading < 0 ? heading + Math.PI * 2 : heading,
    pitchRad: average(samples.map((sample) => sample.pitchRad)),
    rollRad: average(samples.map((sample) => sample.rollRad))
  };
}

function applyMat3ToDirection(matrix: Mat3, direction: Vec3): Vec3 {
  return [
    matrix[0] * direction[0] + matrix[3] * direction[1] + matrix[6] * direction[2],
    matrix[1] * direction[0] + matrix[4] * direction[1] + matrix[7] * direction[2],
    matrix[2] * direction[0] + matrix[5] * direction[1] + matrix[8] * direction[2]
  ];
}

function w3cDeviceToEarthRotation({
  alphaRad,
  betaRad,
  gammaRad
}: W3cDeviceOrientation): Mat3 {
  const cosX = Math.cos(betaRad);
  const cosY = Math.cos(gammaRad);
  const cosZ = Math.cos(alphaRad);
  const sinX = Math.sin(betaRad);
  const sinY = Math.sin(gammaRad);
  const sinZ = Math.sin(alphaRad);
  const m11 = cosZ * cosY - sinZ * sinX * sinY;
  const m12 = -cosX * sinZ;
  const m13 = cosY * sinZ * sinX + cosZ * sinY;
  const m21 = cosY * sinZ + cosZ * sinX * sinY;
  const m22 = cosZ * cosX;
  const m23 = sinZ * sinY - cosZ * cosY * sinX;
  const m31 = -cosX * sinY;
  const m32 = sinX;
  const m33 = cosX * cosY;
  return [
    m11, m21, m31,
    m12, m22, m32,
    m13, m23, m33
  ];
}

function negate(vector: Vec3): Vec3 {
  return [-vector[0], -vector[1], -vector[2]];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
