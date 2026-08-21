import type { Mat3 } from "../domain/types";

const EPSILON = 1e-10;

export type VisualResidualLimits = {
  maxTranslationPx: number;
  maxRotationRad: number;
};

export const DEFAULT_VISUAL_RESIDUAL_LIMITS: Readonly<VisualResidualLimits> = {
  maxTranslationPx: 80,
  maxRotationRad: 0.15
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
  const rotation = clamp(
    Math.atan2(normalized[1], normalized[0]),
    -limits.maxRotationRad,
    limits.maxRotationRad
  );
  const translationLength = Math.hypot(normalized[6], normalized[7]);
  const translationScale =
    translationLength > limits.maxTranslationPx
      ? limits.maxTranslationPx / translationLength
      : 1;
  const translationX = normalized[6] * translationScale;
  const translationY = normalized[7] * translationScale;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return [
    cosine,
    sine,
    0,
    -sine,
    cosine,
    0,
    translationX,
    translationY,
    1
  ];
}

function assertFiniteMatrix(matrix: Mat3): void {
  if (matrix.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Homography values must be finite.");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
