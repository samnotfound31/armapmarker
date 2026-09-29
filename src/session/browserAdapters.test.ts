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
