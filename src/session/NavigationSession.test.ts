import { describe, expect, it, vi } from "vitest";
import type {
  GroundCalibration,
  LocalRoutePoint,
  Mat3,
  RouteGroundPoint,
  RoutePlan
} from "../domain/types";
import type { LocationFix } from "../device/location";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import type { TrackerResult } from "../tracking/types";
import {
  NavigationSession,
  type FrameSample,
  type NavigationSessionAdapters,
  type SensorPoseUpdate
} from "./NavigationSession";

describe("NavigationSession", () => {
  it("feeds sensors, visual tracking, and GPS while keeping progress GPS-owned", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();

    fake.emitLocation(fix(22.5701, 1000));
    const progressBeforeVisual = onUpdate.mock.lastCall?.[0].pose.routeProgressMeters;
    fake.emitTracker(tracked(1010, [1, 0, 0, 0, 1, 0, 40, -10, 1]));

    expect(onUpdate.mock.lastCall?.[0].pose.routeProgressMeters).toBe(
      progressBeforeVisual
    );
    expect(onUpdate.mock.lastCall?.[0].pose.visualCorrection.imageHomography[6]).toBe(40);
  });

  it("stops every source and tracker at arrival and ignores late callbacks", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const onArrived = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived
    });
    await session.start();
    fake.emitLocation(fix(22.5701, 1000));
    fake.emitLocation(fix(22.57096, 2000));

    expect(onArrived).toHaveBeenCalledOnce();
    expect(fake.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(fake.trackerDispose).toHaveBeenCalledOnce();

    const updateCount = onUpdate.mock.calls.length;
    fake.emitLocation(fix(22.5705, 3000));
    expect(onUpdate).toHaveBeenCalledTimes(updateCount);
  });

  it("stops the unstable session when OpenCV becomes unavailable", async () => {
    const fake = createAdapters();
    const onUnavailable = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters,
      onUpdate: vi.fn(),
      onUnavailable,
      onArrived: vi.fn()
    });
    await session.start();

    fake.emitUnavailable("OpenCV failed to initialize");
    expect(onUnavailable).toHaveBeenCalledWith("OpenCV failed to initialize");
    expect(fake.trackerDispose).toHaveBeenCalledOnce();
  });

  it("keeps the calibration camera at the ground-frame origin on the first GPS fix", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const route = routePlan();
    route.origin = { lat: 0, lng: 0 };
    route.destination = { lat: 0.001, lng: 0, name: "Museum" };
    route.distanceMeters = 100;
    const local: LocalRoutePoint[] = [
      { eastMeters: 0, northMeters: 0, upMeters: 0, routeDistanceMeters: 0 },
      { eastMeters: 0, northMeters: 100, upMeters: 0, routeDistanceMeters: 100 }
    ];
    const ground: RouteGroundPoint[] = [
      { rightMeters: 0, upMeters: 0, forwardMeters: -50, routeDistanceMeters: 0 },
      { rightMeters: 0, upMeters: 0, forwardMeters: 50, routeDistanceMeters: 100 }
    ];
    const lock = calibration();
    lock.calibrationRouteDistanceMeters = 50;
    lock.groundFromRoute = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      2, 0, 0, 1
    ];
    const session = new NavigationSession({
      route,
      enuOrigin: route.origin,
      localRoute: local,
      groundRoute: ground,
      calibration: lock,
      adapters: fake.adapters,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();

    fake.emitLocation({
      point: { lat: 0.0004491576, lng: 0 },
      accuracyMeters: 5,
      timestampMs: 1000
    });

    expect(onUpdate.mock.lastCall?.[0].pose.routeProgressMeters).toBeCloseTo(50, 1);
    expect(onUpdate.mock.lastCall?.[0].pose.cameraPositionGroundMeters).toEqual([
      expect.closeTo(0),
      1.4,
      expect.closeTo(0, 1)
    ]);
  });

  it("reports the latest accepted fix and snapped progress for re-alignment", async () => {
    const fake = createAdapters();
    const onLocationAccepted = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters,
      onUpdate: vi.fn(),
      onLocationAccepted,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();
    const latest = fix(22.5705, 2000);

    fake.emitLocation(latest);

    expect(onLocationAccepted).toHaveBeenCalledWith(
      latest,
      expect.closeTo(55.65, 0)
    );
  });

  it("feeds lost tracker quality into the rendered pose immediately", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();
    fake.emitLocation(fix(22.5701, 1000));

    fake.emitTracker({
      status: "lost",
      timestampMs: 1100,
      keyframeId: 1,
      visualHomography: null,
      quality: {
        state: "realign",
        featureCount: 4,
        inlierCount: 0,
        inlierRatio: 0,
        medianReprojectionErrorPx: Number.POSITIVE_INFINITY
      }
    });

    expect(onUpdate.mock.lastCall?.[0].pose.quality.state).toBe("realign");
  });
});

function createAdapters() {
  let locationListener: ((fix: LocationFix) => void) | undefined;
  let sensorListener: ((update: SensorPoseUpdate) => void) | undefined;
  let frameListener: ((sample: FrameSample) => void) | undefined;
  let trackerListener: ((result: TrackerResult) => void) | undefined;
  let unavailableListener: ((message: string) => void) | undefined;
  const disposers = [vi.fn(), vi.fn(), vi.fn()];
  const trackerDispose = vi.fn();
  const adapters: NavigationSessionAdapters = {
    location: {
      subscribe(listener) {
        locationListener = listener;
        return disposers[0]!;
      }
    },
    sensor: {
      subscribe(listener) {
        sensorListener = listener;
        return disposers[1]!;
      }
    },
    frames: {
      subscribe(listener) {
        frameListener = listener;
        return disposers[2]!;
      }
    },
    tracker: {
      async start(callbacks) {
        trackerListener = callbacks.onResult;
        unavailableListener = callbacks.onUnavailable;
      },
      submitFrame: vi.fn(() => true),
      dispose: trackerDispose
    }
  };
  return {
    adapters,
    disposers,
    trackerDispose,
    emitLocation: (fix: LocationFix) => locationListener?.(fix),
    emitSensor: (update: SensorPoseUpdate) => sensorListener?.(update),
    emitFrame: (sample: FrameSample) => frameListener?.(sample),
    emitTracker: (result: TrackerResult) => trackerListener?.(result),
    emitUnavailable: (message: string) => unavailableListener?.(message)
  };
}

function tracked(timestampMs: number, visualHomography: Mat3): TrackerResult {
  return {
    status: "tracked",
    timestampMs,
    keyframeId: 1,
    visualHomography,
    quality: {
      state: "locked",
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    }
  };
}

function fix(lat: number, timestampMs: number): LocationFix {
  return {
    point: { lat, lng: 88.36 },
    accuracyMeters: 5,
    timestampMs
  };
}

function routePlan(): RoutePlan {
  return {
    origin: { lat: 22.57, lng: 88.36 },
    destination: { lat: 22.571, lng: 88.36, name: "Museum" },
    encodedPolyline: "encoded",
    distanceMeters: 111,
    durationSeconds: 90,
    steps: [
      { instruction: "Continue", maneuver: "STRAIGHT", distanceMeters: 111, polyline: "" }
    ]
  };
}

function localRoute(): LocalRoutePoint[] {
  return [
    { eastMeters: 0, northMeters: 0, upMeters: 0, routeDistanceMeters: 0 },
    { eastMeters: 0, northMeters: 111, upMeters: 0, routeDistanceMeters: 111 }
  ];
}

function groundRoute(): RouteGroundPoint[] {
  return [
    { rightMeters: 0, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 0 },
    { rightMeters: 0, upMeters: 0, forwardMeters: 111, routeDistanceMeters: 111 }
  ];
}

function calibration(): GroundCalibration {
  return {
    stage: "locked",
    cameraHeightMeters: 1.4,
    intrinsics: buildApproximateIntrinsics(1280, 720),
    imageToScreen: IDENTITY_MAT3,
    groundFromRoute: IDENTITY_MAT4,
    cameraFromGroundAtLock: IDENTITY_MAT4,
    calibrationRouteDistanceMeters: 0,
    lockedAtMs: 1
  };
}
