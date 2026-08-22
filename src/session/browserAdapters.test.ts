import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroundCalibration, Mat3 } from "../domain/types";
import {
  applyMat3ToPixel,
  rotateCameraFromGroundForScreen
} from "../geometry/displayTransform";
import {
  buildCameraFromGroundWithEarthFrame,
  buildEarthFromGroundAtLock
} from "../geometry/groundCalibration";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import {
  createBrowserNavigationAdapters,
  SensorFrameHomography
} from "./browserAdapters";

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SensorFrameHomography", () => {
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
    const orientation = {
      alphaRad: 0,
      betaRad: Math.PI / 2,
      gammaRad: 0
    };
    const earthFromGroundAtLock = buildEarthFromGroundAtLock(orientation);
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
      calibrationRouteDistanceMeters: 0
    };
    const adapters = createBrowserNavigationAdapters(
      { getTracks: () => [] } as unknown as MediaStream,
      calibration
    );
    let update: Parameters<Parameters<typeof adapters.sensor.subscribe>[0]>[0] | undefined;
    const dispose = adapters.sensor.subscribe((next) => {
      update = next;
    });
    const event = new Event("deviceorientation");
    Object.defineProperties(event, {
      alpha: { value: 0 },
      beta: { value: 90 },
      gamma: { value: 0 }
    });

    window.dispatchEvent(event);

    const raw = buildCameraFromGroundWithEarthFrame(
      orientation,
      earthFromGroundAtLock,
      [0, 1.4, 0]
    );
    expect(update?.cameraFromGround).toEqual(
      rotateCameraFromGroundForScreen(raw, 90)
    );
    dispose();
  });
});
