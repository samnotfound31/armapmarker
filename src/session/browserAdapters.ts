import type {
  CameraIntrinsics,
  GroundCalibration,
  Mat3,
  Mat4
} from "../domain/types";
import type { LocationFix } from "../device/location";
import {
  buildCameraFromGroundWithEarthFrame,
  type W3cDeviceOrientation
} from "../geometry/groundCalibration";
import {
  readScreenOrientationAngle,
  resolveDisplayRotation,
  rotateCameraFromGroundForScreen
} from "../geometry/displayTransform";
import { loadOpenCvTracker } from "../tracking/OpenCvTracker";
import { TrackerClient } from "../tracking/TrackerClient";
import type {
  NavigationSessionAdapters,
  SensorPoseUpdate,
  SessionTracker
} from "./NavigationSession";
import { buildSensorRotationHomography } from "../tracking/residualHomography";

const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export class SensorFrameHomography {
  private previousCameraRotation: Mat3 | null = null;

  constructor(private readonly intrinsics: CameraIntrinsics) {}

  next(currentCameraRotation: Mat3): Mat3 {
    const previous = this.previousCameraRotation;
    this.previousCameraRotation = currentCameraRotation;
    return previous
      ? buildSensorRotationHomography(
          previous,
          currentCameraRotation,
          this.intrinsics
        )
      : IDENTITY_MAT3;
  }
}

export function createBrowserNavigationAdapters(
  stream: MediaStream,
  calibration: GroundCalibration
): NavigationSessionAdapters {
  let latestCameraRotation: Mat3 | null = null;
  return {
    location: createBrowserLocationSource(),
    sensor: createBrowserSensorSource(calibration, (rotation) => {
      latestCameraRotation = rotation;
    }),
    frames: createBrowserFrameSource(
      stream,
      calibration,
      () => latestCameraRotation
    ),
    tracker: new BrowserSessionTracker()
  };
}

function createBrowserLocationSource(): NavigationSessionAdapters["location"] {
  return {
    subscribe(listener, onError) {
      const geolocation = navigator.geolocation;
      if (!geolocation) {
        onError?.("Continuous location is unavailable in this browser.");
        return () => undefined;
      }
      const watchId = geolocation.watchPosition(
        (position) => {
          const point: LocationFix["point"] = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
          };
          if (position.coords.altitude !== null) {
            point.altitudeMeters = position.coords.altitude;
          }
          listener({
            point,
            accuracyMeters: position.coords.accuracy,
            timestampMs: position.timestamp
          });
        },
        (error) => onError?.(locationErrorMessage(error)),
        { enableHighAccuracy: true, maximumAge: 1_000, timeout: 8_000 }
      );
      return () => geolocation.clearWatch(watchId);
    }
  };
}

function createBrowserSensorSource(
  calibration: GroundCalibration,
  onCameraRotation: (rotation: Mat3) => void
): NavigationSessionAdapters["sensor"] {
  return {
    subscribe(listener, onError) {
      const earthFromGround = calibration.earthFromGroundAtLock;
      if (!earthFromGround || typeof DeviceOrientationEvent === "undefined") {
        onError?.("A fixed orientation frame is unavailable. Re-align the route.");
        return () => undefined;
      }
      const onOrientation = (event: DeviceOrientationEvent) => {
        if (event.alpha === null || event.beta === null || event.gamma === null) return;
        try {
          const orientation: W3cDeviceOrientation = {
            alphaRad: degreesToRadians(event.alpha),
            betaRad: degreesToRadians(event.beta),
            gammaRad: degreesToRadians(event.gamma)
          };
          const cameraFromGround = rotateCameraFromGroundForScreen(
            buildCameraFromGroundWithEarthFrame(
              orientation,
              earthFromGround,
              [0, calibration.cameraHeightMeters, 0]
            ),
            resolveDisplayRotation(
              readScreenOrientationAngle(),
              calibration.intrinsics.imageWidthPx,
              calibration.intrinsics.imageHeightPx,
              Math.max(1, window.innerWidth),
              Math.max(1, window.innerHeight)
            )
          );
          onCameraRotation(cameraRotation(cameraFromGround));
          listener({
            timestampMs: event.timeStamp || performance.now(),
            cameraFromGround,
            orientationQuaternion: quaternionFromCameraMatrix(cameraFromGround)
          });
        } catch (error) {
          onError?.(error instanceof Error ? error.message : "Orientation update failed.");
        }
      };
      window.addEventListener("deviceorientation", onOrientation, true);
      return () => window.removeEventListener("deviceorientation", onOrientation, true);
    }
  };
}

function createBrowserFrameSource(
  stream: MediaStream,
  calibration: GroundCalibration,
  readCameraRotation: () => Mat3 | null
): NavigationSessionAdapters["frames"] {
  return {
    subscribe(listener, onError) {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      let stopped = false;
      let frameId = 0;
      let framePending = false;
      let lastCaptureMs = Number.NEGATIVE_INFINITY;
      const sensorFrames = new SensorFrameHomography(calibration.intrinsics);

      const capture = async (timestampMs: number) => {
        if (
          stopped ||
          framePending ||
          timestampMs - lastCaptureMs < 80 ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
          frameId = requestAnimationFrame(capture);
          return;
        }
        framePending = true;
        lastCaptureMs = timestampMs;
        try {
          const frame = await createImageBitmap(video);
          if (stopped) frame.close();
          else {
            const currentCameraRotation = readCameraRotation();
            const sensorHomography =
              currentCameraRotation
                ? sensorFrames.next(currentCameraRotation)
                : IDENTITY_MAT3;
            listener({ frame, timestampMs, sensorHomography });
          }
        } catch (error) {
          if (!stopped) {
            onError?.(
              error instanceof Error ? error.message : "Camera frame capture failed."
            );
          }
        } finally {
          framePending = false;
          if (!stopped) frameId = requestAnimationFrame(capture);
        }
      };

      void video
        .play()
        .then(() => {
          if (!stopped) frameId = requestAnimationFrame(capture);
        })
        .catch((error: unknown) => {
          onError?.(
            error instanceof Error ? error.message : "Camera playback could not start."
          );
        });

      return () => {
        stopped = true;
        cancelAnimationFrame(frameId);
        video.srcObject = null;
      };
    }
  };
}

function cameraRotation(matrix: Mat4): Mat3 {
  return [
    matrix[0], matrix[1], matrix[2],
    matrix[4], matrix[5], matrix[6],
    matrix[8], matrix[9], matrix[10]
  ];
}

class BrowserSessionTracker implements SessionTracker {
  private client: TrackerClient | null = null;

  async start(callbacks: {
    onResult: Parameters<SessionTracker["start"]>[0]["onResult"];
    onUnavailable: Parameters<SessionTracker["start"]>[0]["onUnavailable"];
  }): Promise<void> {
    this.client = new TrackerClient({
      mainThreadFactory: loadOpenCvTracker,
      onResult: callbacks.onResult,
      onUnavailable: callbacks.onUnavailable
    });
    await this.client.start();
  }

  submitFrame(frame: ImageBitmap, timestampMs: number, sensorHomography: Mat3): boolean {
    if (!this.client) {
      frame.close();
      return false;
    }
    return this.client.submitFrame(frame, timestampMs, sensorHomography);
  }

  dispose(): void {
    this.client?.dispose();
    this.client = null;
  }
}

function quaternionFromCameraMatrix(
  matrix: SensorPoseUpdate["cameraFromGround"]
): [number, number, number, number] {
  const m00 = matrix[0];
  const m11 = matrix[5];
  const m22 = matrix[10];
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    w = 0.25 * scale;
    x = (matrix[6] - matrix[9]) / scale;
    y = (matrix[8] - matrix[2]) / scale;
    z = (matrix[1] - matrix[4]) / scale;
  } else if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (matrix[6] - matrix[9]) / scale;
    x = 0.25 * scale;
    y = (matrix[4] + matrix[1]) / scale;
    z = (matrix[8] + matrix[2]) / scale;
  } else if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (matrix[8] - matrix[2]) / scale;
    x = (matrix[4] + matrix[1]) / scale;
    y = 0.25 * scale;
    z = (matrix[9] + matrix[6]) / scale;
  } else {
    const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (matrix[1] - matrix[4]) / scale;
    x = (matrix[8] + matrix[2]) / scale;
    y = (matrix[9] + matrix[6]) / scale;
    z = 0.25 * scale;
  }
  return [x, y, z, w];
}

function locationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return "Location permission was denied.";
  if (error.code === error.TIMEOUT) return "Location update timed out outdoors.";
  return "Live location is unavailable.";
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}
