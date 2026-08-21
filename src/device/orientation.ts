import type { DeviceOrientationSample } from "../domain/types";

export type OrientationReading = {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

export function readCompassHeading(
  reading: OrientationReading
): number | undefined {
  if (Number.isFinite(reading.webkitCompassHeading)) {
    return degreesToRadians(normalizeDegrees(reading.webkitCompassHeading!));
  }
  if (reading.absolute && Number.isFinite(reading.alpha)) {
    return degreesToRadians(normalizeDegrees(360 - reading.alpha!));
  }
  return undefined;
}

export function normalizeDeviceOrientation(
  reading: OrientationReading,
  timestampMs: number
): DeviceOrientationSample {
  const headingRad = readCompassHeading(reading);
  return {
    timestampMs,
    ...(headingRad === undefined ? {} : { headingRad }),
    pitchRad: degreesToRadians(reading.beta ?? 0),
    rollRad: degreesToRadians(reading.gamma ?? 0),
    ...(Number.isFinite(reading.webkitCompassAccuracy)
      ? { headingAccuracyDeg: reading.webkitCompassAccuracy }
      : {}),
    headingSource: Number.isFinite(reading.webkitCompassHeading)
      ? "webkit-compass"
      : reading.absolute && Number.isFinite(reading.alpha)
        ? "absolute-alpha"
        : "unavailable"
  };
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
