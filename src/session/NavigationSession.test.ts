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
  it("keeps an ambiguous initial parallel-leg match geographically uncertain", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const route = routePlan();
    route.origin = { lat: 0, lng: 0 };
    route.distanceMeters = 206;
    const local: LocalRoutePoint[] = [
      { eastMeters: 0, northMeters: 0, upMeters: 0, routeDistanceMeters: 0 },
      { eastMeters: 0, northMeters: 100, upMeters: 0, routeDistanceMeters: 100 },
      { eastMeters: 6, northMeters: 100, upMeters: 0, routeDistanceMeters: 106 },
      { eastMeters: 6, northMeters: 0, upMeters: 0, routeDistanceMeters: 206 }
    ];
    const ground = local.map((point) => ({
      rightMeters: point.eastMeters, upMeters: 0,
      forwardMeters: point.northMeters, routeDistanceMeters: point.routeDistanceMeters
    }));
    const lock = calibration();
    lock.calibrationRouteDistanceMeters = 30;
    lock.geographicYawValidated = true;
    lock.absoluteHeading = {
      headingRad: 0, accuracyDeg: 5, source: "webkit-compass",
      usable: true, reason: "validated", timestampMs: 1000
    };
    const session = new NavigationSession({
      route, localRoute: local, groundRoute: ground, calibration: lock,
      routeFrame: { origin: { eastMeters: 0, northMeters: 0, upMeters: 0 }, tangentBearingRad: 0 },
      initialMatchUncertain: true,
      clock: fake.clock, adapters: fake.adapters, onUpdate,
      onUnavailable: vi.fn(), onArrived: vi.fn()
    });
    await session.start();
    fake.emitLocation({
      point: {
        lat: 30 / 6378137 * 180 / Math.PI,
        lng: 2.9 / 6378137 * 180 / Math.PI
      },
      accuracyMeters: 5,
      timestampMs: TEST_EPOCH + 1000
    });
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("ROUTE_MATCH_UNCERTAIN");
    expect(onUpdate.mock.lastCall![0].navigation.acceptedGpsProgressMeters).toBeCloseTo(30);
    session.stop();
  });

  it("hides guidance without absolute heading and restores it after a valid sensor reading", async () => {
    const fake=createAdapters(); const onUpdate=vi.fn(); const lock=calibration();
    lock.geographicYawValidated=false;
    const session=new NavigationSession({route:routePlan(),localRoute:localRoute(),groundRoute:groundRoute(),calibration:lock,
      clock:fake.clock,adapters:fake.adapters,onUpdate,onUnavailable:vi.fn(),onArrived:vi.fn()});
    await session.start(); fake.emitLocation(fix(22.57,1000));
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("HEADING_UNCERTAIN");
    fake.emitSensor({timestampMs:1001,cameraFromGround:IDENTITY_MAT4,orientationQuaternion:[0,0,0,1],
      absoluteHeading:{headingRad:0,accuracyDeg:5,source:"webkit-compass",usable:true,reason:"validated",timestampMs:1000}});
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("VALID");
    fake.emitSensor({timestampMs:1002,cameraFromGround:IDENTITY_MAT4,orientationQuaternion:[0,0,0,1],
      absoluteHeading:{headingRad:null,source:"unavailable",usable:false,reason:"compass-invalid",timestampMs:1000}});
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("HEADING_UNCERTAIN");
    session.stop();
  });

  it("shows confirmed off-route state even when absolute heading is unavailable", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const east25Meters = 25 / (6378137 * Math.cos(22.57 * Math.PI / 180)) * 180 / Math.PI;
    const session = new NavigationSession({
      route: routePlan(), localRoute: localRoute(), groundRoute: groundRoute(),
      calibration: calibration(), clock: fake.clock, adapters: fake.adapters,
      onUpdate, onUnavailable: vi.fn(), onArrived: vi.fn()
    });
    await session.start();
    for (const timestampMs of [1000, 2000, 3000]) {
      fake.emitLocation({ point: { lat: 22.5701, lng: 88.36 + east25Meters },
        accuracyMeters: 5, timestampMs: TEST_EPOCH + timestampMs });
    }
    expect(onUpdate.mock.lastCall![0].navigation).toMatchObject({ offRoute: true, geographicState: "OFF_ROUTE" });
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("OFF_ROUTE");
    session.stop();
  });

  it("does not show a directional cue from an expired compass reading", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const lock = calibration();
    lock.geographicYawValidated = true;
    lock.absoluteHeading = { headingRad: 0, accuracyDeg: 5, source: "webkit-compass",
      usable: true, reason: "validated", timestampMs: 1000 };
    const session = new NavigationSession({
      route: routePlan(), localRoute: localRoute(), groundRoute: groundRoute(),
      calibration: lock, clock: fake.clock, adapters: fake.adapters,
      onUpdate, onUnavailable: vi.fn(), onArrived: vi.fn()
    });
    await session.start();
    fake.emitLocation(fix(22.57, 1000));
    expect(onUpdate.mock.lastCall![0].geographic.direction).toBe("ahead");
    fake.emitLocation(fix(22.57, 4000));
    expect(onUpdate.mock.lastCall![0].geographic.direction).toBeNull();
    session.stop();
  });
  it("preserves actual lateral GPS position while progress remains route matched", async () => {
    const fake=createAdapters(); const onUpdate=vi.fn();
    const epoch=Date.UTC(2026,8,29); const route=routePlan(); route.origin={lat:0,lng:0};
    const local=localRoute(); const ground=groundRoute(); const lock=calibration();
    const session=new NavigationSession({route, localRoute:local, groundRoute:ground, calibration:lock,
      routeFrame:{origin:{eastMeters:0,northMeters:0,upMeters:0},tangentBearingRad:0},
      clock:{epochNow:()=>epoch,monotonicNow:()=>1000},
      adapters:fake.adapters,onUpdate,onUnavailable:vi.fn(),onArrived:vi.fn()});
    await session.start();
    fake.emitLocation({point:{lat:0,lng:10/6378137*180/Math.PI},accuracyMeters:5,timestampMs:epoch});
    expect(onUpdate.mock.lastCall![0].pose.cameraPositionGroundMeters[0]).toBeCloseTo(10);
    expect(onUpdate.mock.lastCall![0].pose.routeProgressMeters).toBe(0);
    session.stop();
  });

  it("preserves fresh visual correction through epoch GPS updates and rejects poor relocation", async () => {
    const fake=createAdapters(); const onUpdate=vi.fn(); const onArrived=vi.fn();
    let now=1000; const epoch=Date.UTC(2026,8,29);
    const session=new NavigationSession({route:routePlan(),localRoute:localRoute(),groundRoute:groundRoute(),calibration:calibration(),
      clock:{epochNow:()=>epoch+now,monotonicNow:()=>now},adapters:fake.adapters,onUpdate,onUnavailable:vi.fn(),onArrived});
    await session.start();
    fake.emitFrame({frame:{close:vi.fn()} as unknown as ImageBitmap,timestampMs:1000,sensorHomography:IDENTITY_MAT3});
    fake.emitTracker({...tracked(1000,IDENTITY_MAT3),status:"initializing",visualHomography:null});
    now=1050;fake.emitFrame({frame:{close:vi.fn()} as unknown as ImageBitmap,timestampMs:1050,sensorHomography:IDENTITY_MAT3});
    fake.emitTracker(tracked(1050,[1,0,0,0,1,0,25,0,1]));
    now=1100; fake.emitLocation({...fix(22.57,1100),timestampMs:epoch+now});
    expect(onUpdate.mock.lastCall![0].pose.visualCorrection.imageHomography[6]).toBeCloseTo(25);
    const before=onUpdate.mock.lastCall![0].pose;
    now=1200; fake.emitLocation({...fix(22.571,epoch+now),accuracyMeters:100});
    expect(onUpdate.mock.lastCall![0].pose.cameraPositionGroundMeters).toEqual(before.cameraPositionGroundMeters);
    expect(onUpdate.mock.lastCall![0].pose.routeProgressMeters).toBe(before.routeProgressMeters);
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("LOCATION_UNCERTAIN");
    expect(onArrived).not.toHaveBeenCalled(); session.stop();
  });

  it("expires geographic guidance without fresh accepted GPS", async () => {
    vi.useFakeTimers(); const fake=createAdapters(); const onUpdate=vi.fn();
    let now=1000; const epoch=Date.UTC(2026,8,29);
    const session=new NavigationSession({route:routePlan(),localRoute:localRoute(),groundRoute:groundRoute(),calibration:calibration(),
      clock:{epochNow:()=>epoch+now,monotonicNow:()=>now},adapters:fake.adapters,onUpdate,onUnavailable:vi.fn(),onArrived:vi.fn()});
    await session.start(); fake.emitLocation(fix(22.5701,epoch+now));
    now=7000; vi.advanceTimersByTime(6000);
    expect(onUpdate.mock.lastCall![0].pose.geographicState).toBe("LOCATION_UNCERTAIN");
    session.stop(); vi.useRealTimers();
  });
  it("updates the provisional sensor pose while OpenCV is still starting", async () => {
    const fake = createAdapters();
    let ready!: () => void;
    fake.adapters.tracker.start = () => new Promise<void>((resolve) => { ready = resolve; });
    const onUpdate = vi.fn();
    const session = new NavigationSession({route:routePlan(), localRoute:localRoute(), groundRoute:groundRoute(), clock:fake.clock,
      calibration:calibration(), adapters:fake.adapters, onUpdate, onUnavailable:vi.fn(), onArrived:vi.fn()});
    const starting = session.start();
    fake.emitSensor({timestampMs:900,cameraFromGround:IDENTITY_MAT4,orientationQuaternion:[0,0,0,1]});
    expect(onUpdate).toHaveBeenCalledOnce();
    fake.emitLocation(fix(22.5701,1000));
    fake.emitSensor({timestampMs:1010,cameraFromGround:IDENTITY_MAT4,orientationQuaternion:[0,0,0.1,0.995]});
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(session.renderPoseController.sample(1010).timestampMs).toBe(1010);

    session.stop();
    expect(fake.disposers[0]).toHaveBeenCalledOnce();
    expect(fake.disposers[1]).toHaveBeenCalledOnce();
    ready();
    await starting;
    const frame = {close:vi.fn()} as unknown as ImageBitmap;
    fake.emitFrame({frame,timestampMs:1100,sensorHomography:IDENTITY_MAT3});
    expect(fake.adapters.tracker.submitFrame).not.toHaveBeenCalled();
  });

  it("feeds sensors, visual tracking, and GPS while keeping progress GPS-owned", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters, clock: fake.clock,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();

    fake.emitLocation(fix(22.5701, 1000));
    const progressBeforeVisual = onUpdate.mock.lastCall?.[0].pose.routeProgressMeters;
    fake.emitFrame({frame:{close:vi.fn()} as unknown as ImageBitmap,timestampMs:1000,sensorHomography:IDENTITY_MAT3});
    fake.emitTracker({...tracked(1000,IDENTITY_MAT3),status:"initializing",visualHomography:null});
    fake.emitFrame({frame:{close:vi.fn()} as unknown as ImageBitmap,timestampMs:1010,sensorHomography:IDENTITY_MAT3});
    fake.emitTracker(tracked(1010, [1, 0, 0, 0, 1, 0, 40, -10, 1]));

    expect(onUpdate.mock.lastCall?.[0].pose.routeProgressMeters).toBe(
      progressBeforeVisual
    );
    expect(session.renderPoseController.sample(1010).visualCorrection.imageHomography[6]).toBeCloseTo(40);
    session.stop();
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
      adapters: fake.adapters, clock: fake.clock,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived
    });
    await session.start();
    for(let index=0;index<=54;index++) fake.emitLocation(fix(22.57+index*0.000018,index*1000+1000));

    expect(onArrived).toHaveBeenCalledOnce();
    expect(fake.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(fake.trackerDispose).toHaveBeenCalledOnce();

    const updateCount = onUpdate.mock.calls.length;
    fake.emitLocation(fix(22.5705, 3000));
    expect(onUpdate).toHaveBeenCalledTimes(updateCount);
  });

  it("keeps camera/navigation alive and retries a transient tracker failure", async () => {
    const fake = createAdapters();
    const onUnavailable = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters, clock: fake.clock,
      onUpdate: vi.fn(),
      onUnavailable,
      onArrived: vi.fn()
    });
    await session.start();

    fake.emitUnavailable("OpenCV failed to initialize");
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(fake.trackerDispose).toHaveBeenCalledOnce();
    expect(fake.disposers.every(dispose=>dispose.mock.calls.length===0)).toBe(true);
    session.stop();
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
      adapters: fake.adapters, clock: fake.clock,
      onUpdate,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();

    fake.emitLocation({
      point: { lat: 0.0004491576, lng: 0 },
      accuracyMeters: 5,
      timestampMs: TEST_EPOCH+1000
    });

    expect(onUpdate.mock.lastCall?.[0].pose.routeProgressMeters).toBeCloseTo(50, 1);
    expect(onUpdate.mock.lastCall?.[0].pose.cameraPositionGroundMeters).toEqual([
      expect.closeTo(2),
      1.4,
      expect.closeTo(0, 1)
    ]);
  });

  it("reports the latest accepted fix and snapped progress for re-alignment", async () => {
    const fake = createAdapters();
    const onLocationAccepted = vi.fn();
    const initial=calibration(); initial.calibrationRouteDistanceMeters=55.65;
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: initial,
      adapters: fake.adapters, clock: fake.clock,
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

  it("does not report repeated or stale GPS fixes as accepted", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const onLocationAccepted = vi.fn();
    const initial=calibration(); initial.calibrationRouteDistanceMeters=22.26;
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: initial,
      adapters: fake.adapters, clock: fake.clock,
      onUpdate,
      onLocationAccepted,
      onUnavailable: vi.fn(),
      onArrived: vi.fn()
    });
    await session.start();
    const accepted = fix(22.5702, 2000);

    fake.emitLocation(accepted);
    fake.emitLocation(fix(22.5709, 2000));
    fake.emitLocation(fix(22.5708, 1500));

    expect(onLocationAccepted).toHaveBeenCalledOnce();
    expect(onLocationAccepted).toHaveBeenCalledWith(
      accepted,
      expect.closeTo(22.26, 0)
    );
    expect(onUpdate.mock.calls.every(([snapshot]) => snapshot.pose.routeProgressMeters === onUpdate.mock.calls[0]![0].pose.routeProgressMeters)).toBe(true);
  });

  it("ignores a worker supplied REALIGN state and uses elapsed-time silence", async () => {
    const fake = createAdapters();
    const onUpdate = vi.fn();
    const session = new NavigationSession({
      route: routePlan(),
      localRoute: localRoute(),
      groundRoute: groundRoute(),
      calibration: calibration(),
      adapters: fake.adapters, clock: fake.clock,
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

    expect(onUpdate.mock.lastCall?.[0].pose.quality.state).toBe("weak");
    expect(session.renderPoseController.sample(3000).quality.state).toBe("realign");
    session.stop();
  });
});

function createAdapters() {
  let monotonicMs=1000;
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
    clock:{epochNow:()=>TEST_EPOCH+monotonicMs,monotonicNow:()=>monotonicMs},
    adapters,
    disposers,
    trackerDispose,
    emitLocation: (fix: LocationFix) => { monotonicMs=Math.max(monotonicMs,fix.timestampMs-TEST_EPOCH); locationListener?.(fix); },
    emitSensor: (update: SensorPoseUpdate) => sensorListener?.(update),
    emitFrame: (sample: FrameSample) => frameListener?.(sample),
    emitTracker: (result: TrackerResult) => {monotonicMs=Math.max(monotonicMs,result.timestampMs);return trackerListener?.(result);},
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
    timestampMs: TEST_EPOCH+timestampMs
  };
}

const TEST_EPOCH=Date.UTC(2026,8,29);

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
