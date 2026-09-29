import type { DeviceOrientationSample } from "../domain/types";
import { w3cDeviceToEarthRotation, type W3cDeviceOrientation } from "../geometry/groundCalibration";

export type OrientationReading = {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

export type AbsoluteHeadingReading = {
  /** Rear-camera azimuth clockwise from true north: N=0, E=PI/2, S=PI. */
  headingRad: number | null;
  accuracyDeg?: number;
  source: "webkit-compass" | "absolute-alpha" | "unavailable";
  usable: boolean;
  reason: string;
  /** Monotonic application time, never GPS epoch time. */
  timestampMs: number;
  /** Full W3C rotation referenced to geographic ENU rather than a relative yaw. */
  orientation?: W3cDeviceOrientation;
};

export type HeadingValidationConfig = {
  maximumAccuracyDeg: number;
  unreportedAccuracyDeg: number;
  minimumCameraHorizontalProjection: number;
  minimumCompassReferenceHorizontalProjection: number;
};

export const HEADING_VALIDATION_CONFIG: HeadingValidationConfig = {
  maximumAccuracyDeg: 15,
  unreportedAccuracyDeg: 20,
  minimumCameraHorizontalProjection: 0.15,
  minimumCompassReferenceHorizontalProjection: 0.1
};

/**
 * Safari exposes magnetic compass azimuth separately from its arbitrary alpha.
 * The compass describes the device top, not the rear-camera optical axis. Use
 * beta/gamma to derive that optical axis, then apply an explicit WMM declination.
 * W3C absolute orientation uses magnetic ENU too. A screen rotation changes image
 * right/down axes; it cannot change the physical rear-camera heading.
 */
export function readAbsoluteCameraHeading(
  reading: OrientationReading,
  timestampMs: number,
  magneticDeclinationDeg?: number,
  overrides: Partial<HeadingValidationConfig> = {}
): AbsoluteHeadingReading {
  const config = { ...HEADING_VALIDATION_CONFIG, ...overrides };
  const hasWebkit = typeof reading.webkitCompassHeading === "number";
  const source = hasWebkit ? "webkit-compass" : reading.absolute ? "absolute-alpha" : "unavailable";
  const accuracyDeg = Number.isFinite(reading.webkitCompassAccuracy)
    ? reading.webkitCompassAccuracy!
    : config.unreportedAccuracyDeg;
  const rejected = (reason: string): AbsoluteHeadingReading => ({
    headingRad: null, accuracyDeg, source, usable: false, reason, timestampMs
  });
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return rejected("invalid-timestamp");
  if (source === "unavailable") return rejected("absolute-heading-unavailable");
  if (!Number.isFinite(reading.alpha) || !Number.isFinite(reading.beta) || !Number.isFinite(reading.gamma) ||
      reading.alpha! < 0 || reading.alpha! > 360 || Math.abs(reading.beta!) > 180 || Math.abs(reading.gamma!) > 90) {
    return rejected("orientation-invalid");
  }
  if (hasWebkit && (!Number.isFinite(reading.webkitCompassHeading) || reading.webkitCompassHeading! < 0 || reading.webkitCompassHeading! > 360)) {
    return rejected("compass-invalid");
  }
  // Apple's negative accuracy explicitly means uncalibrated/unusable.
  if (accuracyDeg < 0 || accuracyDeg > config.maximumAccuracyDeg) return rejected("compass-inaccurate");
  if (!Number.isFinite(magneticDeclinationDeg) || Math.abs(magneticDeclinationDeg!) > 180) {
    return rejected("declination-unavailable");
  }
  const betaRad = degreesToRadians(reading.beta!);
  const gammaRad = degreesToRadians(reading.gamma!);
  if (hasWebkit && Math.abs(Math.cos(betaRad)) < config.minimumCompassReferenceHorizontalProjection) {
    return rejected("compass-reference-vertical");
  }
  // Device top is column Y of Rz(alpha) Rx(beta) Ry(gamma). Its horizontal
  // azimuth is -alpha while cos(beta)>=0, and flips by PI when pitched past
  // vertical. Establish absolute yaw from that compass before using the rear
  // camera's -Z optical axis. Relative alpha supplies no geographic authority.
  const magneticAlpha = hasWebkit
    ? -degreesToRadians(reading.webkitCompassHeading!) + (Math.cos(betaRad) < 0 ? Math.PI : 0)
    : degreesToRadians(reading.alpha!);
  const orientation = {
    alphaRad: magneticAlpha - degreesToRadians(magneticDeclinationDeg!),
    betaRad,
    gammaRad
  };
  const rotation = w3cDeviceToEarthRotation(orientation);
  const east = -rotation[6];
  const north = -rotation[7];
  if (Math.hypot(east, north) < config.minimumCameraHorizontalProjection) return rejected("camera-heading-undefined");
  const headingRad = normalizeRadians(Math.atan2(east, north));
  return { headingRad, accuracyDeg, source, usable: true, reason: "validated", timestampMs, orientation };
}

export function readCompassHeading(
  reading: OrientationReading
): number | undefined {
  if (typeof reading.webkitCompassHeading === "number" &&
      (!Number.isFinite(reading.webkitCompassHeading) || reading.webkitCompassHeading < 0 ||
       (Number.isFinite(reading.webkitCompassAccuracy) && reading.webkitCompassAccuracy! < 0))) return undefined;
  if (Number.isFinite(reading.webkitCompassHeading) && reading.webkitCompassHeading! >= 0 &&
      !(Number.isFinite(reading.webkitCompassAccuracy) && reading.webkitCompassAccuracy! < 0)) {
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

function normalizeRadians(radians: number): number {
  return ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}
