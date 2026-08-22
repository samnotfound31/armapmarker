import { encode } from "@googlemaps/polyline-codec";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination, PoseEstimate } from "../domain/types";
import type { NavigationSnapshot } from "../navigation/navigationEngine";
import type { DestinationSearchAdapter } from "../components/SearchScreen";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { FakeRenderer } from "../test/fakes/FakeRenderer";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import type { SessionStore } from "../session/sessionStore";
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
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    Object.defineProperty(globalThis.screen, "orientation", {
      configurable: true,
      value: undefined
    });
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

  it("releases the active AR session and camera when WebGL context is lost", async () => {
    const recovery = await setupRecoveryApp();
    const canvas = screen
      .getByLabelText(/augmented reality navigation view/i)
      .querySelector("canvas")!;

    act(() => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });

    expect(await screen.findByRole("heading", { name: "City Museum" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/webgl context was lost/i);
    expect(recovery.sessionStops[0]).toHaveBeenCalledOnce();
    expect(recovery.track.stop).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/augmented reality navigation view/i)).not.toBeInTheDocument();
  });

  it("releases resources and returns to preview when renderer construction fails", async () => {
    const recovery = await setupRecoveryApp({
      startAt: "calibration",
      failRenderer: true
    });

    await completeCalibration();

    expect(await screen.findByRole("heading", { name: "City Museum" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/webgl context unavailable/i);
    expect(recovery.sessionStops[0]).toHaveBeenCalledOnce();
    expect(recovery.track.stop).toHaveBeenCalledOnce();
  });

  it("rebuilds calibration from delivered video dimensions before AR resumes", async () => {
    const recovery = await setupRecoveryApp();
    const video = screen.getByLabelText(/rear camera view/i) as HTMLVideoElement;
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 }
    });

    act(() => video.dispatchEvent(new Event("loadedmetadata")));

    expect(recovery.sessionStops[0]).toHaveBeenCalledOnce();
    expect(recovery.track.stop).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: /align route to the road/i })
    ).toBeVisible();
    expect(recovery.createCalibrationRuntime).toHaveBeenCalledTimes(2);
    expect(recovery.createCalibrationRuntime.mock.calls[1]?.[1]).toEqual({
      imageWidthPx: 1920,
      imageHeightPx: 1080
    });

    await completeCalibration();

    expect(recovery.sessionInputs).toHaveLength(2);
    expect(recovery.sessionInputs[1]?.calibration.intrinsics).toMatchObject({
      imageWidthPx: 1920,
      imageHeightPx: 1080
    });
  });

  it("persists progress only for accepted GPS fixes, not sensor or tracker pose updates", async () => {
    const save = vi.fn<SessionStore["save"]>();
    const store: SessionStore = {
      load: () => null,
      save,
      clear: vi.fn()
    };
    const recovery = await setupRecoveryApp({ sessionStore: store });
    const writesAfterStageChange = save.mock.calls.length;

    act(() => {
      for (let index = 0; index < 40; index += 1) {
        recovery.sessionInputs[0]?.onUpdate(
          runtimeSnapshot(18 + index * 0.01, 82 - index * 0.01, false)
        );
      }
    });

    expect(save).toHaveBeenCalledTimes(writesAfterStageChange);
    act(() => {
      recovery.sessionInputs[0]?.onLocationAccepted?.(recovery.freshFix, 42);
    });
    expect(save).toHaveBeenCalledTimes(writesAfterStageChange + 1);
    expect(save.mock.lastCall?.[0]).toMatchObject({
      stage: "navigating",
      displayedProgressMeters: 42
    });
  });

  it("recomputes a nonzero calibration match from the latest accepted fix on re-alignment", async () => {
    const recovery = await setupRecoveryApp();
    recovery.sessionInputs[0]?.onLocationAccepted?.(
      recovery.freshFix,
      50
    );
    const lost = runtimeSnapshot(50, 50, false);
    lost.navigation.trackingQuality = {
      ...lost.navigation.trackingQuality,
      state: "realign"
    };
    lost.pose.quality = lost.navigation.trackingQuality;
    recovery.sessionInputs[0]?.onUpdate(lost);

    fireEvent.click(await screen.findByRole("button", { name: /^re-align$/i }));
    await completeCalibration();

    expect(recovery.sessionInputs).toHaveLength(2);
    expect(
      recovery.sessionInputs[1]?.calibration.calibrationRouteDistanceMeters
    ).toBeCloseTo(50, 0);
  });

  it("gets a fresh fix and replaces the route when recalculation succeeds", async () => {
    const recovery = await setupRecoveryApp();
    const offRoute = runtimeSnapshot(35, 65, false);
    offRoute.navigation.offRoute = true;
    recovery.sessionInputs[0]?.onUpdate(offRoute);

    fireEvent.click(await screen.findByRole("button", { name: /^recalculate$/i }));

    await waitFor(() => expect(recovery.requestLocation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(recovery.requestRoute).toHaveBeenCalledTimes(2));
    expect(recovery.requestRoute.mock.calls[1]?.[0].origin).toEqual(
      recovery.freshFix.point
    );
    expect(await screen.findByRole("heading", { name: "City Museum" })).toBeVisible();
  });

  it("keeps the existing route preview and explains recalculation failure", async () => {
    const recovery = await setupRecoveryApp({ failRecalculation: true });
    const offRoute = runtimeSnapshot(35, 65, false);
    offRoute.navigation.offRoute = true;
    recovery.sessionInputs[0]?.onUpdate(offRoute);

    fireEvent.click(await screen.findByRole("button", { name: /^recalculate$/i }));

    expect(await screen.findByRole("heading", { name: "City Museum" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /fresh route could not be loaded/i
    );
  });

  it("invalidates the full session while hidden and requires re-alignment on return", async () => {
    const recovery = await setupRecoveryApp();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    fireEvent(document, new Event("visibilitychange"));

    expect(recovery.sessionStops[0]).toHaveBeenCalledOnce();
    expect(
      screen.queryByLabelText(/augmented reality navigation view/i)
    ).not.toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    fireEvent(document, new Event("visibilitychange"));

    expect(
      await screen.findByRole("heading", { name: /align route to the road/i })
    ).toBeVisible();
  });

  it("invalidates active tracking when the physical screen orientation changes", async () => {
    const orientation = new EventTarget();
    Object.defineProperty(orientation, "angle", { value: 90 });
    Object.defineProperty(globalThis.screen, "orientation", {
      configurable: true,
      value: orientation
    });
    const recovery = await setupRecoveryApp();

    act(() => {
      orientation.dispatchEvent(new Event("change"));
    });

    expect(recovery.sessionStops[0]).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("heading", { name: /align route to the road/i })
    ).toBeVisible();
  });

  it("disposes calibration while hidden and requires a fresh road calibration", async () => {
    const lifecycle = await setupRecoveryApp({ startAt: "calibration" });
    await collectCalibrationEvidence();

    setVisibility("hidden");

    expect(lifecycle.calibrationRuntimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.track.enabled).toBe(false);
    expect(screen.getByRole("heading", { name: /navigation paused/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /lock route.*start ar/i })).not.toBeInTheDocument();

    setVisibility("visible");

    expect(lifecycle.createCalibrationRuntime).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("button", { name: /chest.*1\.4 m/i })
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /lock route.*start ar/i })).not.toBeInTheDocument();
  });

  it("invalidates calibration evidence when the physical screen orientation changes", async () => {
    const orientation = installOrientation(90);
    const lifecycle = await setupRecoveryApp({ startAt: "calibration" });
    await collectCalibrationEvidence();

    act(() => orientation.dispatchEvent(new Event("change")));

    expect(lifecycle.calibrationRuntimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.createCalibrationRuntime).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("button", { name: /chest.*1\.4 m/i })
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /lock route.*start ar/i })).not.toBeInTheDocument();
  });

  it("does not recreate calibration or enable tracks for orientation changes while hidden", async () => {
    const orientation = installOrientation(90);
    const lifecycle = await setupRecoveryApp({ startAt: "calibration" });

    setVisibility("hidden");
    act(() => orientation.dispatchEvent(new Event("change")));

    expect(lifecycle.createCalibrationRuntime).toHaveBeenCalledOnce();
    expect(lifecycle.track.enabled).toBe(false);
    expect(screen.getByRole("heading", { name: /navigation paused/i })).toBeVisible();
  });

  it("starts exactly one fresh calibration after becoming visible following hidden rotation", async () => {
    const orientation = installOrientation(90);
    const lifecycle = await setupRecoveryApp({ startAt: "calibration" });

    setVisibility("hidden");
    act(() => orientation.dispatchEvent(new Event("change")));
    setVisibility("visible");
    setVisibility("visible");

    expect(lifecycle.createCalibrationRuntime).toHaveBeenCalledTimes(2);
    expect(lifecycle.calibrationRuntimes).toHaveLength(2);
    expect(lifecycle.calibrationRuntimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.calibrationRuntimes[1]?.dispose).not.toHaveBeenCalled();
    expect(lifecycle.sessionInputs).toHaveLength(0);
    expect(lifecycle.track.enabled).toBe(true);
    expect(await screen.findByRole("heading", { name: /align route to the road/i })).toBeVisible();
  });
});

async function reachNavigation(): Promise<void> {
  await reachCalibration();
  await completeCalibration();
  await screen.findByLabelText(/augmented reality navigation view/i);
}

async function reachCalibration(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /use my location/i }));
  await screen.findByText(/location ready/i);
  fireEvent.click(await screen.findByRole("button", { name: /choose city museum/i }));
  fireEvent.click(await screen.findByRole("button", { name: /start ar walk/i }));
  fireEvent.click(screen.getByRole("button", { name: /enable camera and sensors/i }));
  await screen.findByRole("heading", { name: /align route to the road/i });
}

async function completeCalibration(): Promise<void> {
  await collectCalibrationEvidence();
  fireEvent.click(await screen.findByRole("button", { name: /lock route.*start ar/i }));
}

async function collectCalibrationEvidence(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /chest.*1\.4 m/i }));
  fireEvent.click(screen.getByRole("button", { name: /capture standing pose/i }));
  const roadView = await screen.findByRole("button", { name: /road calibration view/i });
  fireEvent.pointerDown(roadView, { clientX: 100, clientY: 100 });
  fireEvent.pointerDown(roadView, { clientX: 100, clientY: 300 });
  fireEvent.click(await screen.findByRole("button", { name: /scan road features/i }));
  await screen.findByRole("button", { name: /lock route.*start ar/i });
}

async function setupRecoveryApp(
  options: {
    failRecalculation?: boolean;
    failRenderer?: boolean;
    sessionStore?: SessionStore;
    startAt?: "calibration" | "navigating";
  } = {}
) {
  const track = { stop: vi.fn(), enabled: true };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [
      { ...track, getSettings: () => ({ width: 1280, height: 720 }) }
    ]
  } as unknown as MediaStream;
  const initialFix = {
    point: { lat: 22.57, lng: 88.36 },
    accuracyMeters: 5,
    timestampMs: 1000
  };
  const freshFix = {
    point: { lat: 22.57045, lng: 88.36 },
    accuracyMeters: 5,
    timestampMs: 5000
  };
  const requestLocation = vi
    .fn()
    .mockResolvedValueOnce(initialFix)
    .mockResolvedValueOnce(freshFix);
  const routePlan = (origin = initialFix.point) => ({
    origin,
    destination: { ...destination.location, name: destination.name },
    encodedPolyline: encode([[origin.lat, origin.lng], [22.5709, 88.36]]),
    distanceMeters: 100,
    durationSeconds: 80,
    steps: []
  });
  const requestRoute = vi.fn(async ({ origin }: { origin: typeof initialFix.point }) => {
    if (requestRoute.mock.calls.length > 1 && options.failRecalculation) {
      throw new Error("Fresh route could not be loaded.");
    }
    return routePlan(origin);
  });
  const sessionInputs: AppNavigationSessionInput[] = [];
  const sessionStops: ReturnType<typeof vi.fn>[] = [];
  const calibrationRuntimes: CalibrationRuntime[] = [];
  const createCalibrationRuntime = vi.fn((
    _grant: unknown,
    dimensions?: { imageWidthPx: number; imageHeightPx: number }
  ) => {
    const runtime = calibrationRuntime(dimensions);
    calibrationRuntimes.push(runtime);
    return runtime;
  });

  render(
    <App
      destinationAdapter={destinationAdapter()}
      mapAdapter={{ mount: () => () => undefined }}
      requestLocation={requestLocation}
      requestRoute={requestRoute}
      requestAccess={vi.fn(async () => ({ stream, location: initialFix }))}
      createCalibrationRuntime={createCalibrationRuntime}
      createSession={(input) => {
        sessionInputs.push(input);
        const stop = vi.fn();
        sessionStops.push(stop);
        return { start: async () => undefined, stop };
      }}
      sessionStore={options.sessionStore}
      backendFactory={() => {
        if (options.failRenderer) throw new Error("WebGL context unavailable");
        return new FakeRenderer();
      }}
    />
  );
  if (options.startAt === "calibration") await reachCalibration();
  else await reachNavigation();
  return {
    track,
    freshFix,
    requestLocation,
    requestRoute,
    createCalibrationRuntime,
    calibrationRuntimes,
    sessionInputs,
    sessionStops
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state
  });
  fireEvent(document, new Event("visibilitychange"));
}

function installOrientation(angle: number): EventTarget {
  const orientation = new EventTarget();
  Object.defineProperty(orientation, "angle", { value: angle });
  Object.defineProperty(globalThis.screen, "orientation", {
    configurable: true,
    value: orientation
  });
  return orientation;
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

function calibrationRuntime(
  dimensions: { imageWidthPx: number; imageHeightPx: number } = {
    imageWidthPx: 1280,
    imageHeightPx: 720
  }
): CalibrationRuntime {
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
    intrinsics: buildApproximateIntrinsics(
      dimensions.imageWidthPx,
      dimensions.imageHeightPx
    ),
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
