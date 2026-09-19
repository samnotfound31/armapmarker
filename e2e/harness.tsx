import { createRoot } from "react-dom/client";
import type { Destination, PoseEstimate } from "../src/domain/types";
import { ArPermissionError } from "../src/device/permissions";
import type { NavigationSnapshot } from "../src/navigation/navigationEngine";
import type { AppNavigationSessionInput, CalibrationRuntime } from "../src/app/App";
import { App } from "../src/app/App";
import { buildApproximateIntrinsics } from "../src/geometry/intrinsics";
import { FakeRenderer } from "../src/test/fakes/FakeRenderer";
import {
  IDENTITY_MAT3,
  IDENTITY_MAT4
} from "../src/test/geometryFixtures";
import "../src/app/app.css";

const destination: Destination = {
  placeId: "museum-id",
  name: "City Museum",
  formattedAddress: "1 Museum Road",
  location: { lat: 22.5709, lng: 88.36 }
};
const stream = {
  getTracks: () => [],
  getVideoTracks: () => []
} as unknown as MediaStream;
let permissionAttempts = 0;
let activeSession: AppNavigationSessionInput | null = null;
const scenario = new URLSearchParams(location.search).get("scenario");

window.__AR_E2E__ = {
  offRoute: () => emit({ offRoute: true }),
  weak: () => emit({ trackingState: "weak" }),
  realign: () => emit({ trackingState: "realign", realignRequired: true }),
  arrive: () => {
    const snapshot = runtimeSnapshot({ progressMeters: 98, remainingMeters: 2, arrived: true });
    activeSession?.onArrived(snapshot);
  },
  unavailable: () => activeSession?.onUnavailable("OpenCV could not initialize")
};

createRoot(document.getElementById("root")!).render(
  <App
    destinationAdapter={{
      mount(host, { onSelect }) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Choose City Museum";
        button.onclick = () => onSelect(destination);
        host.replaceChildren(button);
        return () => button.remove();
      }
    }}
    mapAdapter={{ mount: () => () => undefined }}
    requestAccess={async () => {
      permissionAttempts += 1;
      if (scenario === "permission-denied" && permissionAttempts === 1) {
        throw new ArPermissionError("camera-denied", "Camera permission was denied.");
      }
      return {
        stream,
        location: {
          point: { lat: 22.57, lng: 88.36 },
          accuracyMeters: 5,
          timestampMs: performance.now()
        }
      };
    }}
    createCalibrationRuntime={() => calibrationRuntime()}
    createSession={(input) => {
      activeSession = input;
      return {
        async start() {
          input.onUpdate(runtimeSnapshot());
        },
        stop() {
          if (activeSession === input) activeSession = null;
        }
      };
    }}
    {...(scenario === "real-renderer"
      ? {}
      : { backendFactory: () => new FakeRenderer() })}
  />
);

function calibrationRuntime(): CalibrationRuntime {
  return {
    feed: {
      captureOrientation: async () => ({
        samples: Array.from({ length: 5 }, () => ({
          headingRad: 0,
          pitchRad: 0.4,
          rollRad: 0
        })),
        cameraFromGroundAtLock: IDENTITY_MAT4,
        earthFromGroundAtLock: IDENTITY_MAT3
      }),
      scanFeatures: async () =>
        Array.from({ length: 20 }, () => ({
          featureCount: 35,
          inlierCount: 20,
          angularMotionRad: 0.04
        }))
    },
    intrinsics: buildApproximateIntrinsics(1280, 720),
    imageToScreen: IDENTITY_MAT3,
    screenPointToGround: ({ yPx }) => (yPx < 150 ? [0, 0, 3] : [0, 0, 6]),
    dispose: () => undefined
  };
}

function emit(options: {
  offRoute?: boolean;
  trackingState?: "locked" | "weak" | "realign";
  realignRequired?: boolean;
}): void {
  activeSession?.onUpdate(runtimeSnapshot(options));
}

function runtimeSnapshot(
  options: {
    progressMeters?: number;
    remainingMeters?: number;
    arrived?: boolean;
    offRoute?: boolean;
    trackingState?: "locked" | "weak" | "realign";
    realignRequired?: boolean;
  } = {}
) {
  const progressMeters = options.progressMeters ?? 18;
  const trackingState = options.trackingState ?? "locked";
  const timestampMs = performance.now();
  const navigation: NavigationSnapshot = {
    routeProgressMeters: progressMeters,
    acceptedGpsProgressMeters: progressMeters,
    remainingDistanceMeters: options.remainingMeters ?? 82,
    nextManeuver: {
      instruction: "Turn left",
      maneuver: "TURN_LEFT",
      distanceToManeuverMeters: 35,
      stepIndex: 0
    },
    offRoute: options.offRoute ?? false,
    trackingQuality: {
      state: trackingState,
      featureCount: trackingState === "locked" ? 40 : 10,
      inlierCount: trackingState === "locked" ? 30 : 6,
      inlierRatio: trackingState === "locked" ? 0.75 : 0.4,
      medianReprojectionErrorPx: trackingState === "locked" ? 1 : 5
    },
    arrived: options.arrived ?? false,
    realignRequired: options.realignRequired ?? false,
    timestampMs
  };
  const pose: PoseEstimate = {
    cameraPositionGroundMeters: [0, 1.4, progressMeters],
    orientationQuaternion: [0, 0, 0, 1],
    cameraFromGround: IDENTITY_MAT4,
    visualCorrection: {
      imageHomography: IDENTITY_MAT3,
      keyframeId: 1,
      timestampMs
    },
    routeProgressMeters: progressMeters,
    quality: navigation.trackingQuality,
    timestampMs
  };
  return { pose, navigation };
}

declare global {
  interface Window {
    __AR_E2E__?: Record<
      "offRoute" | "weak" | "realign" | "arrive" | "unavailable",
      () => void
    >;
  }
}
