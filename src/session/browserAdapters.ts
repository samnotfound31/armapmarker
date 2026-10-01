import { CameraFrameTimeline } from "./CameraFrameTimeline";
import { STABILIZATION_CONFIG } from "../pose/stabilizationConfig";
import type {TrackingFrameContext} from "../tracking/types";
import type {
  CameraIntrinsics,
  GroundCalibration,
  Mat3
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
import { readAbsoluteCameraHeading } from "../device/orientation";
import { magneticDeclinationForLocation } from "../device/magneticDeclination";
import { GEOGRAPHIC_EARTH_FROM_GROUND } from "../geometry/groundCalibration";

const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export class SensorFrameHomography {
  private previousCameraRotation: Mat3 | null = null;

  constructor(private readonly intrinsics: CameraIntrinsics) {}

  next(currentCameraRotation: Mat3): Mat3 {
    const previous = this.previousCameraRotation;
    return previous
      ? buildSensorRotationHomography(
          previous,
          currentCameraRotation,
          this.intrinsics
        )
      : IDENTITY_MAT3;
  }

  commit(acceptedCameraRotation: Mat3): void {
    this.previousCameraRotation = acceptedCameraRotation;
  }
}

export function createBrowserNavigationAdapters(
  _stream: MediaStream,
  calibration: GroundCalibration,
  readLocation?: () => LocationFix | undefined
): NavigationSessionAdapters {
  return {
    ...createBrowserPresentationAdapters(calibration, readLocation),
    location: createBrowserLocationSource(),
    tracker: new BrowserSessionTracker()
  };
}

/** The calibration ghost and guidance share sensor axes and displayed-frame timing. */
export function createBrowserPresentationAdapters(
  calibration: GroundCalibration,
  readLocation?: () => LocationFix | undefined,
  captureBitmaps = true
): Pick<NavigationSessionAdapters, "sensor" | "motion" | "bindVideo" | "frames"> {
  let displayedVideo: HTMLVideoElement | null = null;
  return {
    sensor: createBrowserSensorSource(calibration, readLocation),
    motion: createBrowserMotionSource(calibration),
    bindVideo: (video) => { displayedVideo = video; },
    frames: createBrowserFrameSource(() => displayedVideo, calibration, captureBitmaps)
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
        // A transient GPS timeout/unavailable result does not invalidate the
        // session. Its freshness watchdog downgrades geographic guidance.
        (error) => {
          if (error.code === error.PERMISSION_DENIED) {
            onError?.(locationErrorMessage(error));
          }
        },
        { enableHighAccuracy: true, maximumAge: 1_000, timeout: 8_000 }
      );
      return () => geolocation.clearWatch(watchId);
    }
  };
}

function createBrowserSensorSource(
  calibration: GroundCalibration,
  readLocation?: () => LocationFix | undefined
): NavigationSessionAdapters["sensor"] {
  return {
    subscribe(listener, onError) {
      const earthFromGround = calibration.earthFromGroundAtLock;
      if (!earthFromGround || typeof DeviceOrientationEvent === "undefined") {
        onError?.("A fixed orientation frame is unavailable. Re-align the route.");
        return () => undefined;
      }
      let lastCameraPose = calibration.cameraFromGroundAtLock;
      let latestAbsoluteSampleMs = Number.NEGATIVE_INFINITY;
      const onOrientation = (event: DeviceOrientationEvent) => {
        try {
          const now = eventMonotonicTime(event.timeStamp, performance.now());
          const compass = (event as DeviceOrientationEvent & {
            webkitCompassHeading?: number;
          }).webkitCompassHeading;
          const relativeOnly = event.type !== "deviceorientationabsolute" &&
            !event.absolute && typeof compass !== "number";
          // Some browsers send relative and absolute streams together. A fresh
          // absolute reading keeps its geographic authority until it expires.
          if (relativeOnly && now - latestAbsoluteSampleMs <= 2_000) return;
          const fix = readLocation?.();
          const declination = fix ? magneticDeclinationForLocation(fix.point, Date.now()) : undefined;
          const heading = readAbsoluteCameraHeading(event, now, declination);
          if (heading.usable) latestAbsoluteSampleMs = now;
          if (!heading.usable || !heading.orientation) {
            listener({timestampMs:now,cameraFromGround:lastCameraPose,
              orientationQuaternion:quaternionFromCameraMatrix(lastCameraPose),absoluteHeading:heading});
            return;
          }
          const orientation: W3cDeviceOrientation = {
            ...heading.orientation
          };
          const cameraFromGround = rotateCameraFromGroundForScreen(
            buildCameraFromGroundWithEarthFrame(
              orientation,
              GEOGRAPHIC_EARTH_FROM_GROUND,
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
          lastCameraPose = cameraFromGround;
          listener({
            timestampMs: now,
            cameraFromGround,
            orientationQuaternion: quaternionFromCameraMatrix(cameraFromGround),
            absoluteHeading: heading
          });
        } catch (error) {
          onError?.(error instanceof Error ? error.message : "Orientation update failed.");
        }
      };
      window.addEventListener("deviceorientation", onOrientation, true);
      window.addEventListener("deviceorientationabsolute", onOrientation as EventListener, true);
      return () => {
        window.removeEventListener("deviceorientation", onOrientation, true);
        window.removeEventListener("deviceorientationabsolute", onOrientation as EventListener, true);
      };
    }
  };
}

function createBrowserMotionSource(calibration:GroundCalibration):NonNullable<NavigationSessionAdapters["motion"]>{
 return {subscribe(listener){
  const onMotion=(event:DeviceMotionEvent)=>{
   const r=event.rotationRate;if(!r||![r.alpha,r.beta,r.gamma].every(v=>typeof v==="number"&&Number.isFinite(v)))return;
   const angle=resolveDisplayRotation(readScreenOrientationAngle(),calibration.intrinsics.imageWidthPx,calibration.intrinsics.imageHeightPx,window.innerWidth,window.innerHeight)*Math.PI/180;
   // Device rates beta/gamma/alpha are X/Y/Z. Rear camera axes are X/-Y/-Z;
   // camera-from-world attitude changes with the negative camera angular rate.
   const x=-r.beta!*Math.PI/180,y=r.gamma!*Math.PI/180,z=r.alpha!*Math.PI/180;
   listener({rate:[Math.cos(angle)*x-Math.sin(angle)*y,Math.sin(angle)*x+Math.cos(angle)*y,z],timestampMs:eventMonotonicTime(event.timeStamp,performance.now())});
  };
  window.addEventListener("devicemotion",onMotion);return ()=>window.removeEventListener("devicemotion",onMotion);
 }};
}
export function eventMonotonicTime(timestamp:number,now:number):number{
 const t=timestamp>1e12?timestamp-performance.timeOrigin:timestamp;
 return Number.isFinite(t)&&t>0&&t<=now+5&&now-t<1000?t:now;
}
function createBrowserFrameSource(readVideo:()=>HTMLVideoElement|null,calibration:GroundCalibration,captureBitmaps=true):NavigationSessionAdapters["frames"]{
 return {subscribe(listener){
  let stopped=false,pending=false,lastCapture=-Infinity,callback=0,lastMedia=-Infinity;
  let scheduledVideo:HTMLVideoElement|null=null,lastVideo:HTMLVideoElement|null=null;
  const timeline=new CameraFrameTimeline();
  const schedule=()=>{
   if(stopped)return;
   const video=readVideo();scheduledVideo=video;
   if(video&&typeof video.requestVideoFrameCallback==="function")callback=video.requestVideoFrameCallback(capture);
   else callback=requestAnimationFrame(now=>capture(now));
  };
  const capture=(now:number,metadata?:VideoFrameCallbackMetadata)=>{
   if(stopped)return;
   const video=readVideo();const sourceVideo=scheduledVideo;
   schedule();
   if(video!==sourceVideo)return;
   if(video!==lastVideo){timeline.reset();lastMedia=-Infinity;lastVideo=video;}
   if(!video||video.readyState<HTMLMediaElement.HAVE_CURRENT_DATA)return;
   if(!metadata&&video.currentTime===lastMedia)return;
   lastMedia=video.currentTime;
   const source=metadata as (VideoFrameCallbackMetadata&{captureTime?:number})|undefined;
   const stamp=timeline.stamp({nowMs:now,captureTime:source?.captureTime,expectedDisplayTime:metadata?.expectedDisplayTime,width:video.videoWidth||calibration.intrinsics.imageWidthPx,height:video.videoHeight||calibration.intrinsics.imageHeightPx,orientation:readScreenOrientationAngle()});
   // Publish/freeze the displayed frame pose BEFORE asynchronous bitmap creation.
   listener({frame:null,timestampMs:stamp.imageTimeMs,sensorHomography:IDENTITY_MAT3,stamp});
   if(!captureBitmaps)return;
   if(pending||now-lastCapture<STABILIZATION_CONFIG.captureIntervalMs)return;
   pending=true;lastCapture=now;
   void createImageBitmap(video).then(frame=>{
    if(stopped)frame.close();else listener({frame,timestampMs:stamp.imageTimeMs,sensorHomography:IDENTITY_MAT3,stamp,bitmapDelayMs:performance.now()-now});
   }).catch(()=>{ /* One capture failure is a missing measurement; the confidence watchdog handles silence. */ }).finally(()=>{pending=false;});
  };
  schedule();
  return ()=>{stopped=true;if(scheduledVideo&&typeof scheduledVideo.cancelVideoFrameCallback==="function")scheduledVideo.cancelVideoFrameCallback(callback);else cancelAnimationFrame(callback);};
 }};
}

class BrowserSessionTracker implements SessionTracker {
  private client: TrackerClient | null = null;

  async start(callbacks: {
    onResult: Parameters<SessionTracker["start"]>[0]["onResult"];
    onUnavailable: Parameters<SessionTracker["start"]>[0]["onUnavailable"];
    onDiscarded?:()=>void;
  }): Promise<void> {
    this.client = new TrackerClient({
      mainThreadFactory: loadOpenCvTracker,
      onResult: callbacks.onResult,
      onUnavailable: callbacks.onUnavailable,
      onDiscarded: callbacks.onDiscarded
    });
    await this.client.start();
  }

  submitFrame(frame: ImageBitmap, timestampMs: number, sensorHomography: Mat3, context?:TrackingFrameContext): boolean {
    if (!this.client) {
      frame.close();
      return false;
    }
    return this.client.submitFrame(frame, timestampMs, sensorHomography, context);
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
