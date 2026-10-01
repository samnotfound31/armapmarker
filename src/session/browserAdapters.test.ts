import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroundCalibration, Mat3 } from "../domain/types";
import {
  applyMat3ToPixel,
  rotateCameraFromGroundForScreen
} from "../geometry/displayTransform";
import {
  buildCameraFromGroundWithEarthFrame,
  GEOGRAPHIC_EARTH_FROM_GROUND
} from "../geometry/groundCalibration";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { readAbsoluteCameraHeading } from "../device/orientation";
import { magneticDeclinationForLocation } from "../device/magneticDeclination";
import {
  createBrowserNavigationAdapters,
  SensorFrameHomography
} from "./browserAdapters";

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SensorFrameHomography", () => {
  it("uses A to C when intermediate frame B is rejected", () => {
    const compensator = new SensorFrameHomography(buildApproximateIntrinsics(1280,720,90));
    const rotation = (angle:number): Mat3 => [Math.cos(angle),Math.sin(angle),0,-Math.sin(angle),Math.cos(angle),0,0,0,1];
    compensator.next(IDENTITY);
    compensator.commit(IDENTITY);
    compensator.next(rotation(Math.PI/4)); // dropped: do not commit
    const actual=compensator.next(rotation(Math.PI/2));
    expect(applyMat3ToPixel(actual,{xPx:740,yPx:360})).toEqual({xPx:expect.closeTo(640),yPx:expect.closeTo(460)});
  });
  it("emits image rotation between consecutive frame-time sensor snapshots", () => {
    const compensator = new SensorFrameHomography(
      buildApproximateIntrinsics(1280, 720, 90)
    );
    const quarterTurn: Mat3 = [
      0, 1, 0,
      -1, 0, 0,
      0, 0, 1
    ];

    expect(compensator.next(IDENTITY)).toEqual(IDENTITY);
    compensator.commit(IDENTITY);
    const delta = compensator.next(quarterTurn);

    expect(applyMat3ToPixel(delta, { xPx: 740, yPx: 360 })).toEqual({
      xPx: expect.closeTo(640),
      yPx: expect.closeTo(460)
    });
  });
});

describe("browser sensor display rotation", () => {
  it("uses the portrait video rotation when screen angle is zero", () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("screen", { orientation: { angle: 0 } });
    vi.stubGlobal("DeviceOrientationEvent", class {});
    const earthFromGroundAtLock = GEOGRAPHIC_EARTH_FROM_GROUND;
    const calibration: GroundCalibration = {
      stage: "locked",
      cameraHeightMeters: 1.4,
      intrinsics: buildApproximateIntrinsics(1280, 720),
      imageToScreen: IDENTITY,
      groundFromRoute: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
      ],
      cameraFromGroundAtLock: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
      ],
      earthFromGroundAtLock,
      calibrationRouteDistanceMeters: 0,
      geographicYawValidated:true
    };
    const adapters = createBrowserNavigationAdapters(
      { getTracks: () => [] } as unknown as MediaStream,
      calibration,
      () => ({point:{lat:20.353,lng:85.819},accuracyMeters:5,timestampMs:Date.now()})
    );
    let update: Parameters<Parameters<typeof adapters.sensor.subscribe>[0]>[0] | undefined;
    const dispose = adapters.sensor.subscribe((next) => {
      update = next;
    });
    const event = new Event("deviceorientation");
    Object.defineProperties(event, {
      alpha: { value: 0 },
      beta: { value: 80 },
      gamma: { value: 0 }
      ,absolute:{value:true},webkitCompassHeading:{value:0},webkitCompassAccuracy:{value:5}
    });

    window.dispatchEvent(event);

    const declination=magneticDeclinationForLocation({lat:20.353,lng:85.819},Date.now());
    const heading=readAbsoluteCameraHeading({alpha:0,beta:80,gamma:0,absolute:true,webkitCompassHeading:0,webkitCompassAccuracy:5},
      performance.now(),declination);
    const raw = buildCameraFromGroundWithEarthFrame(
      heading.orientation!,
      earthFromGroundAtLock,
      [0, 1.4, 0]
    );
    const expected = rotateCameraFromGroundForScreen(raw, 90);
    expect(update?.cameraFromGround).toBeDefined();
    update?.cameraFromGround.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index]!, 10);
    });
    const accepted = update;
    const relative = new Event("deviceorientation");
    Object.defineProperties(relative, {
      alpha: { value: 40 }, beta: { value: 80 }, gamma: { value: 0 },
      absolute: { value: false }
    });
    window.dispatchEvent(relative);
    expect(update).toBe(accepted);
    dispose();
  });
});

describe("browser location source", () => {
  it("lets the freshness watchdog handle a transient watch timeout", () => {
    let failWatch: ((error: GeolocationPositionError) => void) | undefined;
    const geolocation = {
      watchPosition: vi.fn((
        _onPosition: PositionCallback,
        onError: PositionErrorCallback
      ) => {
        failWatch = onError;
        return 17;
      }),
      clearWatch: vi.fn()
    };
    vi.stubGlobal("navigator", { geolocation });
    const adapters = createBrowserNavigationAdapters(
      {} as MediaStream,
      {} as GroundCalibration
    );
    const onError = vi.fn();
    const dispose = adapters.location.subscribe(vi.fn(), onError);
    failWatch?.({ code: 3, TIMEOUT: 3, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    expect(onError).not.toHaveBeenCalled();
    failWatch?.({ code: 1, TIMEOUT: 3, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    expect(onError).toHaveBeenCalledWith("Location permission was denied.");
    dispose();
    expect(geolocation.clearWatch).toHaveBeenCalledWith(17);
  });
});

describe("displayed camera timeline",()=>{
 const calibration:GroundCalibration={stage:"locked",cameraHeightMeters:1.4,intrinsics:buildApproximateIntrinsics(320,240),imageToScreen:IDENTITY,groundFromRoute:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],cameraFromGroundAtLock:[1,0,0,0,0,1,0,0,0,0,1,0,0,-1.4,0,1],calibrationRouteDistanceMeters:0};
 it("stamps the displayed image before bitmap completion and closes late bitmaps",async()=>{
  const video=document.createElement("video");let callback:VideoFrameRequestCallback=()=>undefined;
  Object.defineProperties(video,{readyState:{value:2},videoWidth:{value:320},videoHeight:{value:240},currentTime:{value:1},requestVideoFrameCallback:{value:(cb:VideoFrameRequestCallback)=>{callback=cb;return 1;}},cancelVideoFrameCallback:{value:vi.fn()}});
  let resolve!:(bitmap:ImageBitmap)=>void;vi.stubGlobal("createImageBitmap",vi.fn(()=>new Promise<ImageBitmap>(r=>resolve=r)));
  const adapters=createBrowserNavigationAdapters({} as MediaStream,calibration);adapters.bindVideo?.(video);const frames:Parameters<Parameters<typeof adapters.frames.subscribe>[0]>[0][]=[];
  const dispose=adapters.frames.subscribe(f=>frames.push(f));callback(100,{captureTime:90,expectedDisplayTime:110} as VideoFrameCallbackMetadata);
  expect(frames[0]?.frame).toBeNull();expect(frames[0]?.stamp?.imageTimeMs).toBe(90);
  callback(130,{captureTime:120,expectedDisplayTime:140} as VideoFrameCallbackMetadata);
  const close=vi.fn();resolve({close} as unknown as ImageBitmap);await Promise.resolve();
  expect(frames.at(-1)?.stamp).toBe(frames[0]?.stamp);expect(frames[1]?.stamp?.frameId).not.toBe(frames[0]?.stamp?.frameId);
  dispose();expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
 });
 it("fallback tracks only new video frames and releases a bitmap completed after stop",async()=>{
  const video=document.createElement("video");let callback:FrameRequestCallback=()=>undefined;let media=1;
  Object.defineProperties(video,{readyState:{value:2},videoWidth:{value:320},videoHeight:{value:240},currentTime:{get:()=>media},requestVideoFrameCallback:{value:undefined}});
  vi.stubGlobal("requestAnimationFrame",(cb:FrameRequestCallback)=>{callback=cb;return 1;});vi.stubGlobal("cancelAnimationFrame",vi.fn());
  let resolve!:(b:ImageBitmap)=>void;vi.stubGlobal("createImageBitmap",()=>new Promise<ImageBitmap>(r=>resolve=r));
  const adapters=createBrowserNavigationAdapters({} as MediaStream,calibration);adapters.bindVideo?.(video);const receive=vi.fn();const stop=adapters.frames.subscribe(receive);
  callback(100);callback(120);expect(receive).toHaveBeenCalledOnce();media=2;callback(140);expect(receive).toHaveBeenCalledTimes(2);
  stop();const close=vi.fn();resolve({close} as unknown as ImageBitmap);await Promise.resolve();expect(close).toHaveBeenCalledOnce();expect(receive).toHaveBeenCalledTimes(2);
 });
});
