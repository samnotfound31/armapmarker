import type { Mat3, Mat4 } from "../domain/types";

export const LANDSCAPE_VIDEO = { widthPx: 1920, heightPx: 1080 } as const;
export const PORTRAIT_SCREEN = { widthPx: 1080, heightPx: 1920 } as const;

export const IDENTITY_MAT3: Mat3 = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1
];

export const IDENTITY_MAT4: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
];
