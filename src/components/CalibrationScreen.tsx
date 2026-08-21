import { useReducer, useState } from "react";
import type {
  CameraIntrinsics,
  GroundCalibration,
  Mat3,
  Mat4,
  RouteGroundPoint
} from "../domain/types";
import {
  calibrationReducer,
  createCalibrationState,
  type ScanObservation
} from "../calibration/calibrationMachine";
import {
  fitRouteToGroundTransform,
  type OrientationCalibrationSample
} from "../geometry/groundCalibration";
import type { ImagePixel, Vec3 } from "../geometry/intrinsics";

export type CalibrationFeed = {
  captureOrientation: () => Promise<{
    samples: readonly OrientationCalibrationSample[];
    cameraFromGroundAtLock: Mat4;
  }>;
  scanFeatures: () => Promise<readonly ScanObservation[]>;
};

type CalibrationScreenProps = {
  feed: CalibrationFeed;
  screenPointToGround: (point: ImagePixel) => Vec3 | null;
  routeNearPoint: RouteGroundPoint;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  onLock: (calibration: GroundCalibration) => void;
  onBack: () => void;
};

const HEIGHTS = [
  { value: 1.2, label: "Low" },
  { value: 1.4, label: "Chest" },
  { value: 1.6, label: "Eye" }
] as const;

export function CalibrationScreen({
  feed,
  screenPointToGround,
  routeNearPoint,
  intrinsics,
  imageToScreen,
  onLock,
  onBack
}: CalibrationScreenProps) {
  const [state, dispatch] = useReducer(
    calibrationReducer,
    undefined,
    createCalibrationState
  );
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();

  const captureOrientation = async () => {
    setBusy(true);
    setLocalError(undefined);
    try {
      const capture = await feed.captureOrientation();
      dispatch({ type: "CAPTURE_ORIENTATION", ...capture });
    } catch {
      setLocalError("Orientation capture failed. Hold still and try again.");
    } finally {
      setBusy(false);
    }
  };

  const tapRoad = (point: ImagePixel) => {
    const groundPoint = screenPointToGround(point);
    if (!groundPoint) {
      setLocalError("Aim lower at the road so this tap reaches the ground plane.");
      return;
    }
    setLocalError(undefined);
    dispatch({ type: "TAP_GROUND", point: groundPoint });
  };

  const scanRoad = async () => {
    setBusy(true);
    setLocalError(undefined);
    try {
      const observations = await feed.scanFeatures();
      for (const observation of observations) {
        dispatch({ type: "SCAN_OBSERVATION", observation });
      }
    } catch {
      setLocalError("Road feature scan failed. Aim at textured road and retry.");
    } finally {
      setBusy(false);
    }
  };

  const lockRoute = () => {
    if (!state.nearGround || !state.farGround) return;
    const groundFromRoute = fitRouteToGroundTransform(
      routeNearPoint,
      state.nearGround,
      state.farGround
    );
    const event = {
      type: "LOCK" as const,
      intrinsics,
      imageToScreen,
      groundFromRoute,
      calibrationRouteDistanceMeters: routeNearPoint.routeDistanceMeters,
      lockedAtMs: Date.now()
    };
    const locked = calibrationReducer(state, event);
    dispatch(event);
    if (locked.lockedCalibration) onLock(locked.lockedCalibration);
  };

  return (
    <section className="calibration-card" aria-labelledby="calibration-title">
      <div className="preview-heading">
        <div>
          <p className="step-label">Step 3</p>
          <h2 id="calibration-title">Align route to the road</h2>
        </div>
        <button type="button" className="text-button" onClick={onBack}>
          Back
        </button>
      </div>

      <p className="calibration-instruction">{instructionForStage(state.stage)}</p>
      <p className="calibration-safety">
        Stand on the sidewalk and use a flat, visible stretch of road. Keep the
        phone near the selected height.
      </p>

      {state.stage === "select-height" && (
        <div className="height-options" aria-label="Camera height">
          {HEIGHTS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={value === 1.4 ? "height-button is-default" : "height-button"}
              onClick={() =>
                dispatch({ type: "SELECT_HEIGHT", cameraHeightMeters: value })
              }
            >
              <strong>{label}</strong>
              <span>{value.toFixed(1)} m</span>
            </button>
          ))}
        </div>
      )}

      {state.stage === "capture-orientation" && (
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => void captureOrientation()}
        >
          {busy ? "Capturing pose…" : "Capture standing pose"}
        </button>
      )}

      {(state.stage === "tap-near" || state.stage === "tap-far") && (
        <button
          type="button"
          className="road-calibration-view"
          aria-label="Road calibration view"
          onPointerDown={(event) =>
            tapRoad({ xPx: event.clientX, yPx: event.clientY })
          }
        >
          <span className="road-guide" aria-hidden="true" />
          {state.nearGround && <span className="tap-marker near" aria-hidden="true" />}
        </button>
      )}

      {state.stage === "scan-features" && (
        <>
          <progress
            max={20}
            value={state.validScanSamples}
            aria-label="Road scan progress"
          />
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void scanRoad()}
          >
            {busy ? "Scanning road…" : "Scan road features"}
          </button>
        </>
      )}

      {state.stage === "ready" && (
        <button type="button" className="primary-button" onClick={lockRoute}>
          Lock route &amp; start AR
        </button>
      )}

      {(localError || state.retryReason) && (
        <p role="alert">{localError ?? state.retryReason}</p>
      )}
    </section>
  );
}

function instructionForStage(stage: GroundCalibration["stage"]): string {
  switch (stage) {
    case "select-height":
      return "Choose the height of the phone camera above the road.";
    case "capture-orientation":
      return "Stand still and hold the phone at that height.";
    case "tap-near":
      return "Tap a near point on the centre of your walking path.";
    case "tap-far":
      return "Tap a far point on the same path centre.";
    case "scan-features":
      return "Move the phone slowly left and right while standing in place.";
    case "ready":
      return "The route is aligned and ready to lock.";
    case "locked":
      return "Route alignment is locked.";
    case "failed":
      return "Road alignment needs another attempt.";
  }
}
