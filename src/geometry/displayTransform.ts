import type { Mat3, Mat4 } from "../domain/types";
import type { ImagePixel } from "./intrinsics";

export type DisplayRotation = 0 | 90 | 180 | 270;

export type DisplayTransform = {
  imageToScreen: Mat3;
  screenToImage: Mat3;
  scale: number;
  imageToScreenPoint: (point: ImagePixel) => ImagePixel;
  screenToImagePoint: (point: ImagePixel) => ImagePixel;
};

type DisplayTransformInput = {
  imageWidthPx: number;
  imageHeightPx: number;
  screenWidthPx: number;
  screenHeightPx: number;
  rotationDeg: DisplayRotation;
};

export function createDisplayTransform(
  input: DisplayTransformInput
): DisplayTransform {
  const dimensions = [
    input.imageWidthPx,
    input.imageHeightPx,
    input.screenWidthPx,
    input.screenHeightPx
  ];
  if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    throw new RangeError("Image and screen dimensions must be positive.");
  }

  const quarterTurn = input.rotationDeg === 90 || input.rotationDeg === 270;
  const rotatedWidth = quarterTurn ? input.imageHeightPx : input.imageWidthPx;
  const rotatedHeight = quarterTurn ? input.imageWidthPx : input.imageHeightPx;
  const scale = Math.max(
    input.screenWidthPx / rotatedWidth,
    input.screenHeightPx / rotatedHeight
  );
  const offsetX = (input.screenWidthPx - rotatedWidth * scale) / 2;
  const offsetY = (input.screenHeightPx - rotatedHeight * scale) / 2;
  const rotation = rotationMatrix(
    input.rotationDeg,
    input.imageWidthPx,
    input.imageHeightPx
  );
  const cover: Mat3 = [
    scale, 0, 0,
    0, scale, 0,
    offsetX, offsetY, 1
  ];
  const imageToScreen = multiplyMat3(cover, rotation);
  const screenToImage = invertAffineMat3(imageToScreen);

  return {
    imageToScreen,
    screenToImage,
    scale,
    imageToScreenPoint: (point) => applyMat3ToPixel(imageToScreen, point),
    screenToImagePoint: (point) => applyMat3ToPixel(screenToImage, point)
  };
}

export function applyMat3ToPixel(matrix: Mat3, point: ImagePixel): ImagePixel {
  const homogeneous =
    matrix[2] * point.xPx + matrix[5] * point.yPx + matrix[8];
  return {
    xPx:
      (matrix[0] * point.xPx + matrix[3] * point.yPx + matrix[6]) /
      homogeneous,
    yPx:
      (matrix[1] * point.xPx + matrix[4] * point.yPx + matrix[7]) /
      homogeneous
  };
}

export function normalizeScreenOrientationAngle(angleDegrees: number): DisplayRotation {
  if (!Number.isFinite(angleDegrees)) return 0;
  const normalized = ((Math.round(angleDegrees / 90) * 90) % 360 + 360) % 360;
  return normalized as DisplayRotation;
}

export function readScreenOrientationAngle(): DisplayRotation {
  const screenAngle = globalThis.screen?.orientation?.angle;
  const legacyAngle = (globalThis as typeof globalThis & { orientation?: number })
    .orientation;
  return normalizeScreenOrientationAngle(
    typeof screenAngle === "number"
      ? screenAngle
      : typeof legacyAngle === "number"
        ? legacyAngle
        : 0
  );
}

export function resolveDisplayRotation(
  screenAngleDegrees: number,
  imageWidthPx: number,
  imageHeightPx: number,
  screenWidthPx: number,
  screenHeightPx: number
): DisplayRotation {
  const actualAngle = normalizeScreenOrientationAngle(screenAngleDegrees);
  if (actualAngle !== 0) return actualAngle;
  const imageIsPortrait = imageHeightPx > imageWidthPx;
  const screenIsPortrait = screenHeightPx > screenWidthPx;
  return imageIsPortrait === screenIsPortrait ? 0 : 90;
}

export function rotateCameraFromGroundForScreen(
  cameraFromGround: Mat4,
  angleDegrees: number
): Mat4 {
  const angle = (normalizeScreenOrientationAngle(angleDegrees) * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const screenFromCamera: Mat4 = [
    cosine, sine, 0, 0,
    -sine, cosine, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ];
  return multiplyMat4(screenFromCamera, cameraFromGround);
}

function rotationMatrix(
  rotationDeg: DisplayRotation,
  width: number,
  height: number
): Mat3 {
  switch (rotationDeg) {
    case 0:
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    case 90:
      return [0, 1, 0, -1, 0, 0, height, 0, 1];
    case 180:
      return [-1, 0, 0, 0, -1, 0, width, height, 1];
    case 270:
      return [0, -1, 0, 1, 0, 0, 0, width, 1];
  }
}

function multiplyMat3(left: Mat3, right: Mat3): Mat3 {
  const output = Array.from({ length: 9 }, () => 0);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      output[column * 3 + row] =
        left[row]! * right[column * 3]! +
        left[3 + row]! * right[column * 3 + 1]! +
        left[6 + row]! * right[column * 3 + 2]!;
    }
  }
  return output as unknown as Mat3;
}

function multiplyMat4(left: Mat4, right: Mat4): Mat4 {
  const output = Array.from({ length: 16 }, () => 0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      output[column * 4 + row] =
        left[row]! * right[column * 4]! +
        left[4 + row]! * right[column * 4 + 1]! +
        left[8 + row]! * right[column * 4 + 2]! +
        left[12 + row]! * right[column * 4 + 3]!;
    }
  }
  return output as unknown as Mat4;
}

function invertAffineMat3(matrix: Mat3): Mat3 {
  const a = matrix[0];
  const b = matrix[3];
  const c = matrix[1];
  const d = matrix[4];
  const tx = matrix[6];
  const ty = matrix[7];
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) {
    throw new RangeError("Display transform is singular.");
  }
  const inverseA = d / determinant;
  const inverseB = -b / determinant;
  const inverseC = -c / determinant;
  const inverseD = a / determinant;
  return [
    inverseA,
    inverseC,
    0,
    inverseB,
    inverseD,
    0,
    -(inverseA * tx + inverseB * ty),
    -(inverseC * tx + inverseD * ty),
    1
  ];
}
