import { describe, expect, it } from "vitest";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import {
  calibrationReducer,
  createCalibrationState,
  type CalibrationEvent,
  type CalibrationState
} from "./calibrationMachine";

const stableOrientations = Array.from({ length: 5 }, () => ({
  headingRad: 0,
  pitchRad: 0.4,
  rollRad: 0
}));

const goodScan = {
  featureCount: 35,
  inlierCount: 20,
  angularMotionRad: 0.04
};

describe("calibrationReducer", () => {
  it.each([1.2, 1.4, 1.6] as const)(
    "accepts the %s metre camera-height preset",
    (cameraHeightMeters) => {
      const state = calibrationReducer(createCalibrationState(), {
        type: "SELECT_HEIGHT",
        cameraHeightMeters
      });
      expect(state).toMatchObject({
        stage: "capture-orientation",
        cameraHeightMeters
      });
    }
  );

  it("moves from height through two taps and a stable scan to locked", () => {
    let state = createCalibrationState();
    state = reduce(state, {
      type: "SELECT_HEIGHT",
      cameraHeightMeters: 1.4
    });
    state = reduce(state, {
      type: "CAPTURE_ORIENTATION",
      samples: stableOrientations,
      cameraFromGroundAtLock: IDENTITY_MAT4
    });
    state = reduce(state, { type: "TAP_GROUND", point: [0, 0, 3] });
    state = reduce(state, { type: "TAP_GROUND", point: [0, 0, 6] });
    for (let sample = 0; sample < 20; sample += 1) {
      state = reduce(state, { type: "SCAN_OBSERVATION", observation: goodScan });
    }
    expect(state.stage).toBe("ready");
    state = reduce(state, {
      type: "LOCK",
      intrinsics: buildApproximateIntrinsics(1920, 1080),
      imageToScreen: IDENTITY_MAT3,
      groundFromRoute: IDENTITY_MAT4,
      calibrationRouteDistanceMeters: 10,
      lockedAtMs: 1234
    });

    expect(state.stage).toBe("locked");
    expect(state.lockedCalibration).toMatchObject({
      stage: "locked",
      cameraHeightMeters: 1.4,
      lockedAtMs: 1234
    });
  });

  it("rejects a tap before orientation and a far tap under two metres", () => {
    let state = calibrationReducer(createCalibrationState(), {
      type: "TAP_GROUND",
      point: [0, 0, 3]
    });
    expect(state.stage).toBe("select-height");
    expect(state.retryReason).toMatch(/height/i);

    state = readyForNearTap();
    state = reduce(state, { type: "TAP_GROUND", point: [0, 0, 3] });
    state = reduce(state, { type: "TAP_GROUND", point: [0, 0, 4.5] });
    expect(state.stage).toBe("tap-far");
    expect(state.retryReason).toMatch(/two metres/i);
  });

  it.each<{
    label: string;
    near: [number, number, number];
    far: [number, number, number];
  }>([
    { label: "closer to the camera", near: [0, 0, 6], far: [0, 0, 3] },
    { label: "sideways", near: [0, 0, 3], far: [3, 0, 3] },
    { label: "behind the camera", near: [0, 0, 3], far: [0, 0, -4] }
  ])("rejects a $label far tap even with enough separation", ({ near, far }) => {
    let state = readyForNearTap();
    state = reduce(state, { type: "TAP_GROUND", point: near });
    state = reduce(state, { type: "TAP_GROUND", point: far });

    expect(state.stage).toBe("tap-far");
    expect(state.retryReason).toMatch(/farther ahead.*road/i);
  });

  it("accepts a farther forward tap that follows a curved-perspective road", () => {
    let state = readyForNearTap();
    state = reduce(state, { type: "TAP_GROUND", point: [-0.5, 0, 3] });
    state = reduce(state, { type: "TAP_GROUND", point: [1.5, 0, 6] });

    expect(state.stage).toBe("scan-features");
    expect(state.farGround).toEqual([1.5, 0, 6]);
  });

  it("requires twenty stable scan samples and resets on excess motion", () => {
    let state = readyForScan();
    for (let sample = 0; sample < 19; sample += 1) {
      state = reduce(state, { type: "SCAN_OBSERVATION", observation: goodScan });
    }
    expect(state.stage).toBe("scan-features");
    state = reduce(state, {
      type: "SCAN_OBSERVATION",
      observation: { ...goodScan, angularMotionRad: 0.3 }
    });
    expect(state.validScanSamples).toBe(0);
    expect(state.retryReason).toMatch(/steadier/i);
  });

  it("returns an explicit re-align to a fresh unlocked state", () => {
    const state = calibrationReducer(readyForScan(), { type: "REALIGN" });
    expect(state).toEqual(createCalibrationState());
  });
});

function reduce(state: CalibrationState, event: CalibrationEvent): CalibrationState {
  return calibrationReducer(state, event);
}

function readyForNearTap(): CalibrationState {
  let state = calibrationReducer(createCalibrationState(), {
    type: "SELECT_HEIGHT",
    cameraHeightMeters: 1.4
  });
  state = reduce(state, {
    type: "CAPTURE_ORIENTATION",
    samples: stableOrientations,
    cameraFromGroundAtLock: IDENTITY_MAT4
  });
  return state;
}

function readyForScan(): CalibrationState {
  let state = readyForNearTap();
  state = reduce(state, { type: "TAP_GROUND", point: [0, 0, 3] });
  return reduce(state, { type: "TAP_GROUND", point: [0, 0, 6] });
}
