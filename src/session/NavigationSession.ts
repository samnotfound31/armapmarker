import type {
  GroundCalibration,
  GeoPoint,
  LocalRoutePoint,
  Mat3,
  PoseEstimate,
  RouteGroundPoint,
  RoutePlan,
  TrackingQuality
} from "../domain/types";
import type { LocationFix } from "../device/location";
import { applyMat4ToPoint } from "../geometry/groundCalibration";
import {
  NavigationEngine,
  type NavigationSnapshot
} from "../navigation/navigationEngine";
import {
  PoseFusion,
  type SensorPoseUpdate as FusionSensorPoseUpdate
} from "../pose/PoseFusion";
import { toEnu } from "../route/geo";
import { sampleRouteGroundPoint } from "../route/prepareRoute";
import type { TrackerResult } from "../tracking/types";

export type SensorPoseUpdate = FusionSensorPoseUpdate;

export type FrameSample = {
  frame: ImageBitmap;
  timestampMs: number;
  sensorHomography: Mat3;
};

export type SessionSource<T> = {
  subscribe(
    listener: (value: T) => void,
    onError?: (message: string) => void
  ): () => void;
};

export type SessionTracker = {
  start(callbacks: {
    onResult: (result: TrackerResult) => void;
    onUnavailable: (message: string) => void;
  }): Promise<void>;
  submitFrame(frame: ImageBitmap, timestampMs: number, sensorHomography: Mat3): boolean;
  dispose(): void;
};

export type NavigationSessionAdapters = {
  location: SessionSource<LocationFix>;
  sensor: SessionSource<SensorPoseUpdate>;
  frames: SessionSource<FrameSample>;
  tracker: SessionTracker;
};

export type NavigationRuntimeSnapshot = {
  pose: PoseEstimate;
  navigation: NavigationSnapshot;
};

export type NavigationSessionOptions = {
  route: RoutePlan;
  enuOrigin?: GeoPoint;
  localRoute: readonly LocalRoutePoint[];
  groundRoute: readonly RouteGroundPoint[];
  calibration: GroundCalibration;
  adapters: NavigationSessionAdapters;
  onUpdate: (snapshot: NavigationRuntimeSnapshot) => void;
  onLocationAccepted?: (fix: LocationFix, progressMeters: number) => void;
  onUnavailable: (message: string) => void;
  onArrived: (snapshot: NavigationRuntimeSnapshot) => void;
};

const INITIAL_TRACKING_QUALITY: TrackingQuality = {
  state: "weak",
  featureCount: 0,
  inlierCount: 0,
  inlierRatio: 0,
  medianReprojectionErrorPx: Number.POSITIVE_INFINITY
};

export class NavigationSession {
  private readonly fusion: PoseFusion;
  private readonly engine: NavigationEngine;
  private readonly disposers: Array<() => void> = [];
  private active = false;
  private latestQuality = INITIAL_TRACKING_QUALITY;
  private latestNavigation: NavigationSnapshot | null = null;

  constructor(private readonly options: NavigationSessionOptions) {
    this.fusion = new PoseFusion(options.calibration);
    this.engine = new NavigationEngine(
      options.localRoute,
      options.route.steps,
      options.route.distanceMeters,
      options.calibration.calibrationRouteDistanceMeters
    );
  }

  async start(): Promise<void> {
    if (this.active) throw new Error("Navigation session is already running.");
    this.active = true;
    try {
      await this.options.adapters.tracker.start({
        onResult: (result) => this.handleTrackerResult(result),
        onUnavailable: (message) => this.handleUnavailable(message)
      });
      if (!this.active) return;
      this.disposers.push(
        this.options.adapters.location.subscribe(
          (fix) => this.handleLocation(fix),
          (message) => this.handleUnavailable(message)
        ),
        this.options.adapters.sensor.subscribe(
          (update) => this.handleSensor(update),
          (message) => this.handleUnavailable(message)
        ),
        this.options.adapters.frames.subscribe(
          (sample) => this.handleFrame(sample),
          (message) => this.handleUnavailable(message)
        )
      );
    } catch (error) {
      const message = errorMessage(error, "Visual tracking could not start.");
      if (this.active) this.options.onUnavailable(message);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (!this.active && this.disposers.length === 0) return;
    this.active = false;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.options.adapters.tracker.dispose();
  }

  private handleLocation(fix: LocationFix): void {
    if (!this.active) return;
    const localPosition = toEnu(
      fix.point,
      this.options.enuOrigin ?? this.options.route.origin
    );
    const destinationOffset = toEnu(this.options.route.destination, fix.point);
    const navigation = this.engine.update({
      position: localPosition,
      gpsAccuracyMeters: fix.accuracyMeters,
      distanceToDestinationMeters: Math.hypot(
        destinationOffset.eastMeters,
        destinationOffset.northMeters
      ),
      timestampMs: fix.timestampMs,
      trackingQuality: this.latestQuality,
      calibrationDisagreement: this.latestQuality.state === "realign"
    });
    this.latestNavigation = navigation;
    this.options.onLocationAccepted?.(
      fix,
      navigation.acceptedGpsProgressMeters
    );
    const routePosition = sampleRouteGroundPoint(
      this.options.groundRoute,
      navigation.routeProgressMeters
    );
    const groundPosition = applyMat4ToPoint(
      this.options.calibration.groundFromRoute,
      [routePosition.rightMeters, routePosition.upMeters, routePosition.forwardMeters]
    );
    const calibrationRoutePosition = sampleRouteGroundPoint(
      this.options.groundRoute,
      this.options.calibration.calibrationRouteDistanceMeters
    );
    const calibrationGroundPosition = applyMat4ToPoint(
      this.options.calibration.groundFromRoute,
      [
        calibrationRoutePosition.rightMeters,
        calibrationRoutePosition.upMeters,
        calibrationRoutePosition.forwardMeters
      ]
    );
    this.fusion.updateGps({
      timestampMs: fix.timestampMs,
      routeProgressMeters: navigation.routeProgressMeters,
      cameraPositionGroundMeters: [
        groundPosition[0] - calibrationGroundPosition[0],
        groundPosition[1] - calibrationGroundPosition[1] +
          this.options.calibration.cameraHeightMeters,
        groundPosition[2] - calibrationGroundPosition[2]
      ]
    });
    const snapshot = this.emit(fix.timestampMs);
    if (navigation.arrived) {
      this.options.onArrived(snapshot);
      this.stop();
    }
  }

  private handleSensor(update: SensorPoseUpdate): void {
    if (!this.active) return;
    if (this.fusion.updateSensor(update) && this.latestNavigation) {
      this.emit(update.timestampMs);
    }
  }

  private handleFrame(sample: FrameSample): void {
    if (!this.active) {
      sample.frame.close();
      return;
    }
    this.options.adapters.tracker.submitFrame(
      sample.frame,
      sample.timestampMs,
      sample.sensorHomography
    );
  }

  private handleTrackerResult(result: TrackerResult): void {
    if (!this.active) return;
    this.latestQuality = result.quality;
    if (result.status === "tracked" && result.visualHomography) {
      this.fusion.updateVisual({
        imageHomography: result.visualHomography,
        keyframeId: result.keyframeId,
        timestampMs: result.timestampMs,
        quality: result.quality
      });
    }
    if (this.latestNavigation) this.emit(result.timestampMs);
  }

  private handleUnavailable(message: string): void {
    if (!this.active) return;
    this.options.onUnavailable(message);
    this.stop();
  }

  private emit(timestampMs: number): NavigationRuntimeSnapshot {
    if (!this.latestNavigation) {
      throw new Error("Navigation state is unavailable before the first location fix.");
    }
    const snapshot = {
      pose: {
        ...this.fusion.snapshot(timestampMs),
        quality: this.latestQuality
      },
      navigation: {
        ...this.latestNavigation,
        trackingQuality: this.latestQuality
      }
    };
    this.options.onUpdate(snapshot);
    return snapshot;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
