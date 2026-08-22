import type { CameraIntrinsics, Mat3 } from "../domain/types";

const EPSILON = 1e-10;

export type VisualResidualLimits = {
  imageWidthPx: number;
  imageHeightPx: number;
  maxPointDisplacementPx: number;
  maxConditionNumber: number;
};

export const DEFAULT_VISUAL_RESIDUAL_LIMITS: Readonly<VisualResidualLimits> = {
  imageWidthPx: 1280,
  imageHeightPx: 720,
  maxPointDisplacementPx: 80,
  maxConditionNumber: 20
};

export function computeResidualHomography(
  observedHomography: Mat3,
  sensorHomography: Mat3
): Mat3 {
  assertFiniteMatrix(observedHomography);
  assertFiniteMatrix(sensorHomography);
  return normalizeHomography(
    multiplyHomographies(observedHomography, invertHomography(sensorHomography))
  );
}

export function buildSensorRotationHomography(
  previousCameraFromGround: Mat3,
  currentCameraFromGround: Mat3,
  intrinsics: CameraIntrinsics
): Mat3 {
  const cameraDelta = multiplyHomographies(
    currentCameraFromGround,
    invertHomography(previousCameraFromGround)
  );
  const imageFromCamera: Mat3 = [
    intrinsics.fxPx, 0, 0,
    0, intrinsics.fyPx, 0,
    intrinsics.cxPx, intrinsics.cyPx, 1
  ];
  return normalizeHomography(
    multiplyHomographies(
      imageFromCamera,
      multiplyHomographies(cameraDelta, invertHomography(imageFromCamera))
    )
  );
}

export function multiplyHomographies(left: Mat3, right: Mat3): Mat3 {
  assertFiniteMatrix(left);
  assertFiniteMatrix(right);
  const result = new Array<number>(9);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      result[column * 3 + row] =
        left[row]! * right[column * 3]! +
        left[3 + row]! * right[column * 3 + 1]! +
        left[6 + row]! * right[column * 3 + 2]!;
    }
  }
  return result as unknown as Mat3;
}

export function invertHomography(matrix: Mat3): Mat3 {
  assertFiniteMatrix(matrix);
  const a = matrix[0];
  const b = matrix[3];
  const c = matrix[6];
  const d = matrix[1];
  const e = matrix[4];
  const f = matrix[7];
  const g = matrix[2];
  const h = matrix[5];
  const i = matrix[8];
  const cofactor00 = e * i - f * h;
  const cofactor01 = c * h - b * i;
  const cofactor02 = b * f - c * e;
  const cofactor10 = f * g - d * i;
  const cofactor11 = a * i - c * g;
  const cofactor12 = c * d - a * f;
  const cofactor20 = d * h - e * g;
  const cofactor21 = b * g - a * h;
  const cofactor22 = a * e - b * d;
  const determinant = a * cofactor00 + b * cofactor10 + c * cofactor20;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= EPSILON) {
    throw new RangeError("Homography is singular.");
  }
  const inverse = 1 / determinant;
  return [
    cofactor00 * inverse,
    cofactor10 * inverse,
    cofactor20 * inverse,
    cofactor01 * inverse,
    cofactor11 * inverse,
    cofactor21 * inverse,
    cofactor02 * inverse,
    cofactor12 * inverse,
    cofactor22 * inverse
  ];
}

export function normalizeHomography(matrix: Mat3): Mat3 {
  assertFiniteMatrix(matrix);
  const divisor = matrix[8];
  if (Math.abs(divisor) <= EPSILON) {
    throw new RangeError("Homography cannot be normalized because h33 is zero.");
  }
  return matrix.map((value) => value / divisor) as unknown as Mat3;
}

export function limitVisualResidual(
  matrix: Mat3,
  limits: Readonly<VisualResidualLimits> = DEFAULT_VISUAL_RESIDUAL_LIMITS
): Mat3 {
  const normalized = normalizeHomography(matrix);
  assertVisualResidualLimits(limits);
  assertPlausibleProjectiveMatrix(normalized, limits);
  if (maximumSampleDisplacement(normalized, limits) <= limits.maxPointDisplacementPx) {
    return normalized;
  }

  let lowerWeight = 0;
  let upperWeight = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const weight = (lowerWeight + upperWeight) / 2;
    const candidate = interpolateFromIdentity(normalized, weight);
    if (
      maximumSampleDisplacement(candidate, limits) <=
      limits.maxPointDisplacementPx
    ) {
      lowerWeight = weight;
    } else {
      upperWeight = weight;
    }
  }
  const bounded = interpolateFromIdentity(normalized, lowerWeight);
  assertPlausibleProjectiveMatrix(bounded, limits);
  return bounded;
}

function assertFiniteMatrix(matrix: Mat3): void {
  if (matrix.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Homography values must be finite.");
  }
}

function assertVisualResidualLimits(limits: Readonly<VisualResidualLimits>): void {
  const values = [
    limits.imageWidthPx,
    limits.imageHeightPx,
    limits.maxPointDisplacementPx,
    limits.maxConditionNumber
  ];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("Visual residual bounds must be positive and finite.");
  }
}

function assertPlausibleProjectiveMatrix(
  matrix: Mat3,
  limits: Readonly<VisualResidualLimits>
): void {
  const normalizedCoordinates = toNormalizedImageCoordinates(matrix, limits);
  const determinant = determinant3(normalizedCoordinates);
  if (Math.abs(determinant) <= 1e-8) {
    throw new RangeError("Homography is near-singular.");
  }
  if (determinant < 0) {
    throw new RangeError("Homography reverses image orientation.");
  }
  const conditionNumber = frobeniusConditionNumber(normalizedCoordinates);
  if (!Number.isFinite(conditionNumber) || conditionNumber > limits.maxConditionNumber) {
    throw new RangeError("Homography condition number is unreasonable.");
  }
  for (const point of samplePoints(limits)) {
    const denominator =
      matrix[2] * point.xPx + matrix[5] * point.yPx + matrix[8];
    if (!Number.isFinite(denominator) || denominator <= 1e-6) {
      throw new RangeError("Homography reverses orientation within the image.");
    }
  }
}

function toNormalizedImageCoordinates(
  matrix: Mat3,
  limits: Readonly<VisualResidualLimits>
): Mat3 {
  const halfWidth = limits.imageWidthPx / 2;
  const halfHeight = limits.imageHeightPx / 2;
  const imageFromNormalized: Mat3 = [
    halfWidth, 0, 0,
    0, halfHeight, 0,
    halfWidth, halfHeight, 1
  ];
  const normalizedFromImage: Mat3 = [
    1 / halfWidth, 0, 0,
    0, 1 / halfHeight, 0,
    -1, -1, 1
  ];
  return normalizeHomography(
    multiplyHomographies(
      normalizedFromImage,
      multiplyHomographies(matrix, imageFromNormalized)
    )
  );
}

function frobeniusConditionNumber(matrix: Mat3): number {
  const inverse = invertHomography(matrix);
  return (
    Math.hypot(...matrix) * Math.hypot(...inverse) / 3
  );
}

function determinant3(matrix: Mat3): number {
  return (
    matrix[0] * (matrix[4] * matrix[8] - matrix[7] * matrix[5]) -
    matrix[3] * (matrix[1] * matrix[8] - matrix[7] * matrix[2]) +
    matrix[6] * (matrix[1] * matrix[5] - matrix[4] * matrix[2])
  );
}

function maximumSampleDisplacement(
  matrix: Mat3,
  limits: Readonly<VisualResidualLimits>
): number {
  return Math.max(
    ...samplePoints(limits).map((point) => {
      const transformed = transformPoint(matrix, point.xPx, point.yPx);
      return Math.hypot(transformed.xPx - point.xPx, transformed.yPx - point.yPx);
    })
  );
}

function samplePoints(limits: Readonly<VisualResidualLimits>) {
  const { imageWidthPx: width, imageHeightPx: height } = limits;
  return [
    { xPx: 0, yPx: 0 },
    { xPx: width, yPx: 0 },
    { xPx: 0, yPx: height },
    { xPx: width, yPx: height },
    { xPx: width / 2, yPx: height / 2 }
  ];
}

function transformPoint(matrix: Mat3, xPx: number, yPx: number) {
  const denominator = matrix[2] * xPx + matrix[5] * yPx + matrix[8];
  return {
    xPx: (matrix[0] * xPx + matrix[3] * yPx + matrix[6]) / denominator,
    yPx: (matrix[1] * xPx + matrix[4] * yPx + matrix[7]) / denominator
  };
}

function interpolateFromIdentity(matrix: Mat3, weight: number): Mat3 {
  return normalizeHomography([
    1 + (matrix[0] - 1) * weight,
    matrix[1] * weight,
    matrix[2] * weight,
    matrix[3] * weight,
    1 + (matrix[4] - 1) * weight,
    matrix[5] * weight,
    matrix[6] * weight,
    matrix[7] * weight,
    1 + (matrix[8] - 1) * weight
  ]);
}
