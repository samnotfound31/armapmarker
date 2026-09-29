import type { CalibrationFeed } from "../components/CalibrationScreen";
import type { CameraIntrinsics, Mat3 } from "../domain/types";
import type { LocationFix } from "../device/location";
import { magneticDeclinationForLocation } from "../device/magneticDeclination";
import { readAbsoluteCameraHeading, type AbsoluteHeadingReading, type OrientationReading } from "../device/orientation";
import {
  buildCameraFromGroundAtLock,
  buildCameraFromGroundWithEarthFrame,
  GEOGRAPHIC_EARTH_FROM_GROUND,
  intersectImageRayWithGround,
  w3cDeviceToEarthRotation,
  type W3cDeviceOrientation
} from "../geometry/groundCalibration";
import {
  createDisplayTransform,
  readScreenOrientationAngle,
  resolveDisplayRotation,
  rotateCameraFromGroundForScreen,
} from "../geometry/displayTransform";
import { buildApproximateIntrinsics, type ImagePixel, type Vec3 } from "../geometry/intrinsics";
import { loadOpenCvTracker, type OpenCvTracker } from "../tracking/OpenCvTracker";

const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export type BrowserCalibrationRuntime = {
  feed: CalibrationFeed;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  screenPointToGround(
    point: ImagePixel,
    viewport?: { widthPx: number; heightPx: number }
  ): Vec3 | null;
  dispose(): void;
};

export type CameraImageDimensions = {
  imageWidthPx: number;
  imageHeightPx: number;
};

export function createBrowserCalibrationRuntime(
  stream: MediaStream,
  deliveredDimensions?: Readonly<CameraImageDimensions>,
  location?: LocationFix
): BrowserCalibrationRuntime {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const imageWidthPx = deliveredDimensions?.imageWidthPx ?? settings?.width ?? 1280;
  const imageHeightPx = deliveredDimensions?.imageHeightPx ?? settings?.height ?? 720;
  const screenWidthPx = Math.max(1, window.innerWidth);
  const screenHeightPx = Math.max(1, window.innerHeight);
  const intrinsics = buildApproximateIntrinsics(imageWidthPx, imageHeightPx);
  const displayRotation = resolveDisplayRotation(
    readScreenOrientationAngle(),
    imageWidthPx,
    imageHeightPx,
    screenWidthPx,
    screenHeightPx
  );
  const display = createDisplayTransform({
    imageWidthPx,
    imageHeightPx,
    screenWidthPx,
    screenHeightPx,
    rotationDeg: displayRotation
  });
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  void video.play().catch(() => undefined);

  let disposed = false;
  const cancelled = new AbortController();
  let tracker: OpenCvTracker | null = null;
  let cameraFromGroundAtLock: ReturnType<typeof buildCameraFromGroundAtLock> | null =
    null;
  let cameraHeightMeters = 1.4;
  let lastMotion: W3cDeviceOrientation | null = null;
  let angularMotionRad = 0;
  const onMotion = (event: DeviceOrientationEvent) => {
    const next = orientationFromEvent(event);
    if (!next) return;
    if (lastMotion) {
      angularMotionRad = Math.hypot(
        wrappedAngle(next.alphaRad - lastMotion.alphaRad),
        next.betaRad - lastMotion.betaRad,
        next.gammaRad - lastMotion.gammaRad
      );
    }
    lastMotion = next;
  };
  window.addEventListener("deviceorientation", onMotion, true);
  window.addEventListener("deviceorientationabsolute", onMotion, true);

  const feed: CalibrationFeed = {
    async captureOrientation(selectedHeight = 1.4) {
      cameraHeightMeters = selectedHeight;
      const captured = await collectOrientationSamples(5, 4_000, cancelled.signal);
      const declination = location ? magneticDeclinationForLocation(location.point, Date.now()) : undefined;
      const headings = captured.map((sample) => readAbsoluteCameraHeading(sample.reading, performance.now(), declination));
      const headingMean = circularMean(headings.filter((heading) => heading.usable).map((heading) => heading.headingRad!));
      const stable = headings.every((heading) => heading.usable && Math.abs(wrappedAngle(heading.headingRad! - headingMean)) <= Math.PI / 12);
      const average = averageW3cOrientations(captured.map((sample, index) =>
        stable ? headings[index]!.orientation! : sample.orientation));
      const lastHeading = headings.at(-1)!;
      const geographicRotation = w3cDeviceToEarthRotation(average);
      const absoluteHeading: AbsoluteHeadingReading = stable
        ? { ...lastHeading, headingRad: normalizeRadians(Math.atan2(-geographicRotation[6], -geographicRotation[7])),
            accuracyDeg: Math.max(...headings.map((heading) => heading.accuracyDeg ?? 20)), orientation: average }
        : { ...lastHeading, headingRad: null, usable: false,
            reason: headings.find((heading) => !heading.usable)?.reason ?? "compass-unstable", orientation: undefined };
      const earthFromGroundAtLock = GEOGRAPHIC_EARTH_FROM_GROUND;
      cameraFromGroundAtLock = rotateCameraFromGroundForScreen(
        buildCameraFromGroundWithEarthFrame(average, earthFromGroundAtLock, [0, cameraHeightMeters, 0]),
        displayRotation
      );
      return {
        samples: stable ? headings.map((heading) => ({
          headingRad: heading.headingRad!, pitchRad: heading.orientation!.betaRad, rollRad: heading.orientation!.gammaRad
        })) : [],
        cameraFromGroundAtLock,
        earthFromGroundAtLock,
        absoluteHeading
      };
    },
    async scanFeatures() {
      tracker ??= await loadOpenCvTracker();
      const observations = [];
      for (let index = 0; index < 21; index += 1) {
        if (disposed) throw new Error("Calibration was cancelled.");
        await nextAnimationFrame();
        const frame = await createImageBitmap(video);
        try {
          const result = await tracker.process(frame, performance.now(), IDENTITY_MAT3);
          if (result.status !== "initializing") {
            observations.push({
              featureCount: result.quality.featureCount,
              inlierCount: result.quality.inlierCount,
              angularMotionRad
            });
            angularMotionRad = 0;
          }
        } finally {
          frame.close();
        }
      }
      return observations;
    }
  };

  return {
    feed,
    intrinsics,
    imageToScreen: display.imageToScreen,
    screenPointToGround(point, viewport) {
      if (!cameraFromGroundAtLock) return null;
      const tapDisplay =
        viewport && viewport.widthPx > 0 && viewport.heightPx > 0
          ? createDisplayTransform({
              imageWidthPx,
              imageHeightPx,
              screenWidthPx: viewport.widthPx,
              screenHeightPx: viewport.heightPx,
              // The card crops the camera image; its aspect ratio must not
              // rotate taps away from the orientation captured above.
              rotationDeg: displayRotation
            })
          : display;
      const imagePoint = tapDisplay.screenToImagePoint(point);
      return intersectImageRayWithGround(
        imagePoint,
        intrinsics,
        inverseCameraRotation(cameraFromGroundAtLock),
        [0, cameraHeightMeters, 0]
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelled.abort();
      window.removeEventListener("deviceorientation", onMotion, true);
      window.removeEventListener("deviceorientationabsolute", onMotion, true);
      tracker?.dispose();
      tracker = null;
      video.srcObject = null;
    }
  };
}

function collectOrientationSamples(
  count: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ reading: OrientationReading; orientation: W3cDeviceOrientation }[]> {
  return new Promise((resolve, reject) => {
    const samples: { reading: OrientationReading; orientation: W3cDeviceOrientation }[] = [];
    let usesAbsoluteSamples = false;
    const clean = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("deviceorientation", onOrientation, true);
      window.removeEventListener("deviceorientationabsolute", onOrientation, true);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { clean(); reject(new Error("Calibration was cancelled.")); };
    const timeout = window.setTimeout(() => {
      clean();
      reject(new Error("Orientation samples timed out."));
    }, timeoutMs);
    const onOrientation = (event: DeviceOrientationEvent) => {
      const orientation = orientationFromEvent(event);
      if (!orientation) return;
      const reading = { ...eventReading(event), absolute: event.absolute || event.type === "deviceorientationabsolute" };
      const hasAbsolute = typeof reading.webkitCompassHeading === "number" || reading.absolute;
      if (usesAbsoluteSamples && !hasAbsolute) return;
      if (hasAbsolute && !usesAbsoluteSamples) { samples.length = 0; usesAbsoluteSamples = true; }
      samples.push({ reading, orientation });
      if (samples.length < count) return;
      clean();
      resolve(samples);
    };
    window.addEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function orientationFromEvent(
  event: DeviceOrientationEvent
): W3cDeviceOrientation | null {
  if (!Number.isFinite(event.alpha) || !Number.isFinite(event.beta) || !Number.isFinite(event.gamma) ||
      Math.abs(event.beta!) > 180 || Math.abs(event.gamma!) > 90) return null;
  return {
    alphaRad: degreesToRadians(event.alpha!),
    betaRad: degreesToRadians(event.beta!),
    gammaRad: degreesToRadians(event.gamma!)
  };
}

function eventReading(event: DeviceOrientationEvent): OrientationReading {
  const compass = event as DeviceOrientationEvent & OrientationReading;
  return { alpha: event.alpha, beta: event.beta, gamma: event.gamma, absolute: event.absolute,
    webkitCompassHeading: compass.webkitCompassHeading, webkitCompassAccuracy: compass.webkitCompassAccuracy };
}

function averageW3cOrientations(
  values: readonly W3cDeviceOrientation[]
): W3cDeviceOrientation {
  return {
    alphaRad: circularMean(values.map((value) => value.alphaRad)),
    betaRad: average(values.map((value) => value.betaRad)),
    gammaRad: average(values.map((value) => value.gammaRad))
  };
}

function inverseCameraRotation(
  matrix: ReturnType<typeof buildCameraFromGroundAtLock>
): Mat3 {
  return [
    matrix[0], matrix[4], matrix[8],
    matrix[1], matrix[5], matrix[9],
    matrix[2], matrix[6], matrix[10]
  ];
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function circularMean(values: readonly number[]): number {
  return Math.atan2(
    average(values.map((value) => Math.sin(value))),
    average(values.map((value) => Math.cos(value)))
  );
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function wrappedAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizeRadians(value: number): number {
  return ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}
