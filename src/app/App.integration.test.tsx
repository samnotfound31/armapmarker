import { encode } from "@googlemaps/polyline-codec";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination, PoseEstimate } from "../domain/types";
import type { NavigationSnapshot } from "../navigation/navigationEngine";
import type { DestinationSearchAdapter } from "../components/SearchScreen";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { FakeRenderer } from "../test/fakes/FakeRenderer";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import {
  App,
  type AppNavigationSessionInput,
  type CalibrationRuntime
} from "./App";

const destination: Destination = {
  placeId: "museum-id",
  name: "City Museum",
  formattedAddress: "1 Museum Road",
  location: { lat: 22.5709, lng: 88.36 }
};

describe("App integrated AR walk", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe() {
          this.callback(
            [{ contentRect: { width: 390, height: 844 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
        }
        disconnect() {}
        unobserve() {}
      }
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  it("drives search through calibration, GPS progress, maneuver, and arrival", async () => {
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
      getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 720 }) }]
    } as unknown as MediaStream;
    const backend = new FakeRenderer();
    let sessionInput: AppNavigationSessionInput | undefined;
    const sessionStop = vi.fn();
    const createSession = vi.fn((input: AppNavigationSessionInput) => {
      sessionInput = input;
      return { start: vi.fn(async () => undefined), stop: sessionStop };
    });

    render(
      <App
        destinationAdapter={destinationAdapter()}
        mapAdapter={{ mount: () => () => undefined }}
        requestLocation={vi.fn(async () => ({
          point: { lat: 22.57, lng: 88.36 },
          accuracyMeters: 5,
          timestampMs: 1000
        }))}
        requestRoute={vi.fn(async () => ({
          origin: { lat: 22.57, lng: 88.36 },
          destination: { ...destination.location, name: destination.name },
          encodedPolyline: encode([
            [22.57, 88.36],
            [22.5709, 88.36]
          ]),
          distanceMeters: 100,
          durationSeconds: 80,
          steps: [
            {
              instruction: "Turn left",
              maneuver: "TURN_LEFT",
              distanceMeters: 100,
              polyline: ""
            }
          ]
        }))}
        requestAccess={vi.fn(async () => ({
          stream,
          location: {
            point: { lat: 22.57, lng: 88.36 },
            accuracyMeters: 5,
            timestampMs: 1000
          }
        }))}
        createCalibrationRuntime={() => calibrationRuntime()}
        createSession={createSession}
        backendFactory={() => backend}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /use my location/i }));
    await screen.findByText(/location ready/i);
    fireEvent.click(await screen.findByRole("button", { name: /choose city museum/i }));
    fireEvent.click(await screen.findByRole("button", { name: /start ar walk/i }));
    fireEvent.click(screen.getByRole("button", { name: /enable camera and sensors/i }));

    expect(await screen.findByRole("heading", { name: /align route to the road/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /chest.*1\.4 m/i }));
    fireEvent.click(screen.getByRole("button", { name: /capture standing pose/i }));
    const roadView = await screen.findByRole("button", { name: /road calibration view/i });
    fireEvent.pointerDown(roadView, { clientX: 100, clientY: 100 });
    fireEvent.pointerDown(roadView, { clientX: 100, clientY: 300 });
    fireEvent.click(await screen.findByRole("button", { name: /scan road features/i }));
    fireEvent.click(await screen.findByRole("button", { name: /lock route.*start ar/i }));

    expect(createSession).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText(/augmented reality navigation view/i)).toBeVisible();

    sessionInput?.onUpdate(runtimeSnapshot(18, 82, false));
    expect(await screen.findByText(/82 m remaining/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: /turn left/i })).toBeVisible();

    sessionInput?.onArrived(runtimeSnapshot(98, 2, true));
    expect(await screen.findByRole("heading", { name: /you arrived at city museum/i })).toBeVisible();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(sessionStop).toHaveBeenCalled();
  });

  it("returns to route preview with a compatibility action when tracking is unavailable", async () => {
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
      getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 720 }) }]
    } as unknown as MediaStream;
    let sessionInput: AppNavigationSessionInput | undefined;
    render(
      <App
        destinationAdapter={destinationAdapter()}
        mapAdapter={{ mount: () => () => undefined }}
        requestLocation={vi.fn(async () => ({
          point: { lat: 22.57, lng: 88.36 }, accuracyMeters: 5, timestampMs: 1
        }))}
        requestRoute={vi.fn(async () => ({
          origin: { lat: 22.57, lng: 88.36 },
          destination: { ...destination.location, name: destination.name },
          encodedPolyline: encode([[22.57, 88.36], [22.5709, 88.36]]),
          distanceMeters: 100,
          durationSeconds: 80,
          steps: []
        }))}
        requestAccess={vi.fn(async () => ({
          stream,
          location: { point: { lat: 22.57, lng: 88.36 }, accuracyMeters: 5, timestampMs: 1 }
        }))}
        createCalibrationRuntime={() => calibrationRuntime()}
        createSession={(input) => {
          sessionInput = input;
          return { start: async () => undefined, stop: vi.fn() };
        }}
        backendFactory={() => new FakeRenderer()}
      />
    );

    await reachNavigation();
    sessionInput?.onUnavailable("OpenCV could not initialize");

    expect(await screen.findByRole("heading", { name: "City Museum" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/opencv could not initialize/i);
    expect(screen.queryByLabelText(/augmented reality navigation view/i)).not.toBeInTheDocument();
  });
});

async function reachNavigation(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /use my location/i }));
  await screen.findByText(/location ready/i);
  fireEvent.click(await screen.findByRole("button", { name: /choose city museum/i }));
  fireEvent.click(await screen.findByRole("button", { name: /start ar walk/i }));
  fireEvent.click(screen.getByRole("button", { name: /enable camera and sensors/i }));
  await screen.findByRole("heading", { name: /align route to the road/i });
  fireEvent.click(screen.getByRole("button", { name: /chest.*1\.4 m/i }));
  fireEvent.click(screen.getByRole("button", { name: /capture standing pose/i }));
  const roadView = await screen.findByRole("button", { name: /road calibration view/i });
  fireEvent.pointerDown(roadView, { clientX: 100, clientY: 100 });
  fireEvent.pointerDown(roadView, { clientX: 100, clientY: 300 });
  fireEvent.click(await screen.findByRole("button", { name: /scan road features/i }));
  fireEvent.click(await screen.findByRole("button", { name: /lock route.*start ar/i }));
  await screen.findByLabelText(/augmented reality navigation view/i);
}

function destinationAdapter(): DestinationSearchAdapter {
  return {
    mount(host, { onSelect }) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Choose City Museum";
      button.onclick = () => onSelect(destination);
      host.replaceChildren(button);
      return () => button.remove();
    }
  };
}

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
    screenPointToGround: ({ yPx }) => (yPx < 200 ? [0, 0, 3] : [0, 0, 6]),
    dispose: vi.fn()
  };
}

function runtimeSnapshot(
  progressMeters: number,
  remainingDistanceMeters: number,
  arrived: boolean
) {
  const navigation: NavigationSnapshot = {
    routeProgressMeters: progressMeters,
    acceptedGpsProgressMeters: progressMeters,
    remainingDistanceMeters,
    nextManeuver: {
      instruction: "Turn left",
      maneuver: "TURN_LEFT",
      distanceToManeuverMeters: 35,
      stepIndex: 0
    },
    offRoute: false,
    trackingQuality: {
      state: "locked",
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    },
    arrived,
    realignRequired: false,
    timestampMs: 1000 + progressMeters
  };
  const pose: PoseEstimate = {
    cameraPositionGroundMeters: [0, 1.4, progressMeters],
    orientationQuaternion: [0, 0, 0, 1],
    cameraFromGround: IDENTITY_MAT4,
    visualCorrection: {
      imageHomography: IDENTITY_MAT3,
      keyframeId: 1,
      timestampMs: navigation.timestampMs
    },
    routeProgressMeters: progressMeters,
    quality: navigation.trackingQuality,
    timestampMs: navigation.timestampMs
  };
  return { pose, navigation };
}
