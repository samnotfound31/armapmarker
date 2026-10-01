import { RenderPoseController } from "../pose/RenderPoseController";
import { CameraFrameTimeline, type CameraFrameStamp } from "./CameraFrameTimeline";
import type {TrackingFrameContext} from "../tracking/types";
import type {
  GroundCalibration,
  GeoPoint,
  LocalRoutePoint,
  Mat3,
  PoseEstimate,
  RouteGroundPoint,
  RoutePlan,
  TrackingQuality,
  AbsoluteHeading
} from "../domain/types";
import type { LocationFix } from "../device/location";
import { AcceptedLocationFilter } from "../device/AcceptedLocationFilter";
import { applyMat4ToPoint } from "../geometry/groundCalibration";
import {
  NavigationEngine,
  selectNextManeuver,
  type NavigationSnapshot
} from "../navigation/navigationEngine";
import {
  PoseFusion,
  type SensorPoseUpdate as FusionSensorPoseUpdate
} from "../pose/PoseFusion";
import { toEnu, toRouteLocal, type RouteFrame } from "../route/geo";
import { sampleRouteGroundPoint } from "../route/prepareRoute";
import type { TrackerResult } from "../tracking/types";

export type SensorPoseUpdate = FusionSensorPoseUpdate;

export type FrameSample = {
  frame: ImageBitmap | null;
  stamp?: CameraFrameStamp;
  bitmapDelayMs?:number;
  timestampMs: number;
  sensorHomography: Mat3;
  onAccepted?: () => void;
};

export type SessionSource<T> = {
  subscribe(
    listener: (value: T) => void,
    onError?: (message: string) => void
  ): () => void;
};

export type SessionTracker = {
  start(callbacks: {
    onResult: (result: TrackerResult) => boolean | void;
    onUnavailable: (message: string) => void;
    onDiscarded?:()=>void;
  }): Promise<void>;
  submitFrame(frame: ImageBitmap, timestampMs: number, sensorHomography: Mat3, context?:TrackingFrameContext): boolean;
  dispose(): void;
};

export type NavigationSessionAdapters = {
  bindVideo?: (video:HTMLVideoElement|null)=>void;
  motion?:SessionSource<{rate:[number,number,number];timestampMs:number}>;
  location: SessionSource<LocationFix>;
  sensor: SessionSource<SensorPoseUpdate>;
  frames: SessionSource<FrameSample>;
  tracker: SessionTracker;
};

export type NavigationRuntimeSnapshot = {
  pose: PoseEstimate;
  navigation: NavigationSnapshot;
  geographic: {
    locationStatus: string;
    locationReason: string;
    locationAccuracyMeters: number | null;
    locationAgeMs: number | null;
    heading: AbsoluteHeading | null;
    headingAgeMs: number | null;
    direction: "left" | "right" | "behind" | "ahead" | null;
  };
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
  routeFrame?: RouteFrame;
  initialLocation?: LocationFix;
  initialMatchUncertain?: boolean;
  clock?: { epochNow(): number; monotonicNow(): number };
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
  readonly renderPoseController:RenderPoseController;
  private readonly fallbackTimeline=new CameraFrameTimeline();
  private readonly submittedFrames=new Map<number,TrackingFrameContext>();
  private displayedFrames=new Map<number,TrackingFrameContext>();
  private readonly engine: NavigationEngine;
  private readonly disposers: Array<() => void> = [];
  private active = false;
  private retryTimer:ReturnType<typeof setTimeout>|null=null;
  private restartCount=0;
  private lastUiUpdate=-Infinity;
  private lastUiKey="";
  private latestQuality = INITIAL_TRACKING_QUALITY;
  private latestNavigation: NavigationSnapshot | null = null;
  private readonly locationFilter = new AcceptedLocationFilter();
  private readonly clock;
  private latestHeading: AbsoluteHeading | null;
  private geographicOrientationAvailable: boolean;
  private latestPosition: LocalRoutePoint | null = null;
  private locationStatus = "REJECTED";
  private locationReason = "awaiting-location";
  private locationAccuracyMeters: number | null = null;

  constructor(private readonly options: NavigationSessionOptions) {
    this.fusion = new PoseFusion(options.calibration);
    this.renderPoseController=new RenderPoseController(options.calibration);
    this.clock = options.clock ?? {
      epochNow: () => Date.now(),
      monotonicNow: () => performance.now()
    };
    this.latestHeading = options.calibration.absoluteHeading ?? null;
    this.geographicOrientationAvailable = Boolean(options.calibration.geographicYawValidated);
    const progress = options.calibration.calibrationRouteDistanceMeters;
    this.latestNavigation = {
      routeProgressMeters: progress,
      acceptedGpsProgressMeters: progress,
      remainingDistanceMeters: Math.max(0, options.route.distanceMeters - progress),
      nextManeuver: selectNextManeuver(options.route.steps, progress),
      offRoute: false,
      arrived: false,
      realignRequired: false,
      trackingQuality: INITIAL_TRACKING_QUALITY,
      timestampMs: options.calibration.lockedAtMs ?? 0,
      geographicState: "LOCATION_UNCERTAIN"
    };
    this.renderPoseController.setNavigation(progress,"LOCATION_UNCERTAIN");
    this.engine = new NavigationEngine(
      options.localRoute,
      options.route.steps,
      options.route.distanceMeters,
      options.calibration.calibrationRouteDistanceMeters,
      { initialMatchUncertain: options.initialMatchUncertain === true }
    );
  }

  async start(): Promise<void> {
    if (this.active) throw new Error("Navigation session is already running.");
    this.active = true;
    try {
      // Keep the provisional ground pose responsive while OpenCV downloads or
      // initializes. Frame processing starts only once the tracker is ready.
      const subscribe = <T>(source: SessionSource<T>, listener: (value: T) => void) => {
        if (!this.active) return;
        const dispose = source.subscribe(listener, (message) => this.handleUnavailable(message));
        if (this.active) this.disposers.push(dispose);
        else dispose();
      };
      subscribe(this.options.adapters.location, (fix) => this.handleLocation(fix));
      subscribe(this.options.adapters.sensor, (update) => this.handleSensor(update));
      if(this.options.adapters.motion)subscribe(this.options.adapters.motion,update=>this.renderPoseController.updateRate(update.rate,update.timestampMs));
      const watchdog = setInterval(() => {
        if (this.active) this.emit(this.clock.monotonicNow());
      }, 250);
      this.disposers.push(() => clearInterval(watchdog));
      if (this.options.initialLocation) this.handleLocation(this.options.initialLocation);
      if (!this.active) return;
      subscribe(this.options.adapters.frames, (sample) => this.handleFrame(sample));
      await this.startTracker();
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
    if(this.retryTimer)clearTimeout(this.retryTimer);this.retryTimer=null;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.options.adapters.tracker.dispose();
  }

  private handleLocation(fix: LocationFix): void {
    if (!this.active) return;
    const now = this.clock.monotonicNow();
    const decision = this.locationFilter.accept(fix, this.clock.epochNow(), now);
    this.locationStatus = decision.status;
    this.locationReason = decision.reason;
    this.locationAccuracyMeters = Number.isFinite(fix.accuracyMeters) ? fix.accuracyMeters : null;
    if (!decision.accepted) {
      this.emit(now);
      return;
    }
    const localPosition = toEnu(
      fix.point,
      this.options.enuOrigin ?? this.options.route.origin
    );
    const destinationOffset = toEnu(this.options.route.destination, fix.point);
    const navigationUpdate = this.engine.update({
      position: localPosition,
      gpsAccuracyMeters: fix.accuracyMeters,
      distanceToDestinationMeters: Math.hypot(
        destinationOffset.eastMeters,
        destinationOffset.northMeters
      ),
      timestampMs: now,
      locationUsable: true,
      headingReliable: this.headingUsable(now),
      trackingQuality: this.latestQuality,
      calibrationDisagreement: this.latestQuality.state === "realign"
    });
    if (!navigationUpdate.accepted) return;
    const navigation = navigationUpdate.snapshot;
    this.latestPosition = localPosition;
    this.latestNavigation = navigation;
    this.options.onLocationAccepted?.(
      fix,
      navigation.acceptedGpsProgressMeters
    );
    const frame = this.options.routeFrame ?? inferRouteFrame(
      this.options.localRoute,
      this.options.groundRoute
    );
    const actualRoutePosition = toRouteLocal(localPosition, frame);
    const groundPosition = applyMat4ToPoint(
      this.options.calibration.groundFromRoute,
      [actualRoutePosition.rightMeters, 0, actualRoutePosition.forwardMeters]
    );
    const poseUpdate={
      timestampMs: now,
      routeProgressMeters: navigation.routeProgressMeters,
      cameraPositionGroundMeters: [
        groundPosition[0],
        this.options.calibration.cameraHeightMeters,
        groundPosition[2]
      ]
    } as const;
    this.fusion.updateGps({...poseUpdate,cameraPositionGroundMeters:[...poseUpdate.cameraPositionGroundMeters]});
    this.renderPoseController.updateGps({...poseUpdate,cameraPositionGroundMeters:[...poseUpdate.cameraPositionGroundMeters]},fix.accuracyMeters);
    const snapshot = this.emit(now);
    if (navigation.arrived && navigation.geographicState !== "ROUTE_MATCH_UNCERTAIN") {
      this.options.onArrived(snapshot);
      this.stop();
    }
  }

  private handleSensor(update: SensorPoseUpdate): void {
    if (!this.active) return;
    if (update.absoluteHeading) {
      this.latestHeading = update.absoluteHeading;
      if (update.absoluteHeading.usable) this.geographicOrientationAvailable = true;
    }
    this.renderPoseController.updateSensor(update);
    if (this.fusion.updateSensor(update) && this.latestNavigation) {
      this.emit(this.clock.monotonicNow(),false);
    }
  }

  attachVideo(video:HTMLVideoElement|null){this.options.adapters.bindVideo?.(video);}
  private handleFrame(sample:FrameSample){
   if(!this.active){sample.frame?.close();return;}
   const stamp=sample.stamp??this.fallbackTimeline.stamp({nowMs:sample.timestampMs,width:this.options.calibration.intrinsics.imageWidthPx,height:this.options.calibration.intrinsics.imageHeightPx,orientation:0});
   let context=this.displayedFrames.get(stamp.frameId);
   if(!context){
    if(sample.stamp&&sample.frame){sample.frame.close();this.renderPoseController.noteDropped();return;}
    context=this.renderPoseController.captureFrame(stamp);this.displayedFrames.set(stamp.frameId,context);
    for(const [id,old]of this.displayedFrames)if(stamp.imageTimeMs-old.imageTimeMs>2000)this.displayedFrames.delete(id);
   }
   if(!sample.frame)return;
   this.renderPoseController.noteTiming({bitmapDelayMs:sample.bitmapDelayMs??0});
   const accepted=this.options.adapters.tracker.submitFrame(sample.frame,sample.timestampMs,sample.sensorHomography,context);
   if(accepted){this.submittedFrames.set(sample.timestampMs,context);sample.onAccepted?.();}
   else this.renderPoseController.noteDropped();
   for(const [time]of this.submittedFrames)if(stamp.imageTimeMs-time>2000)this.submittedFrames.delete(time);
  }
  private async startTracker(){
   try{await this.options.adapters.tracker.start({onResult:result=>this.handleTrackerResult(result),onUnavailable:message=>this.handleTrackerUnavailable(message),onDiscarded:()=>this.renderPoseController.noteDiscardedResult()});}
   catch(error){this.handleTrackerUnavailable(errorMessage(error,"Visual tracking is recovering."));}
  }
  private handleTrackerUnavailable(message:string){
   if(!this.active||this.retryTimer)return;
   this.renderPoseController.visualUnavailable(message);this.options.adapters.tracker.dispose();
   this.retryTimer=setTimeout(()=>{this.retryTimer=null;if(this.active)void this.startTracker();},Math.min(30000,1000*2**Math.min(5,this.restartCount++)));
  }

  private handleTrackerResult(result:TrackerResult):boolean{
   if(!this.active)return false;
   const context=result.context??this.submittedFrames.get(result.timestampMs);
   const accepted=this.renderPoseController.acceptTracking({...result,context},this.clock.monotonicNow());
   this.submittedFrames.delete(result.timestampMs);
   const pose=this.renderPoseController.sample(this.clock.monotonicNow());this.latestQuality=pose.quality;
   if(accepted)this.restartCount=0;
   if(accepted&&result.status==="tracked")this.fusion.updateVisual({...pose.visualCorrection,quality:pose.quality});
   if(this.latestNavigation)this.emit(this.clock.monotonicNow(),false);
   return accepted;
  }

  private handleUnavailable(message: string): void {
    if (!this.active) return;
    this.options.onUnavailable(message);
    this.stop();
  }

  private emit(timestampMs: number,force=true): NavigationRuntimeSnapshot {
    if (!this.latestNavigation) {
      throw new Error("Navigation state is unavailable before the first location fix.");
    }
    const freshness = this.locationFilter.freshness(timestampMs);
    const locationUsable = freshness.usable && this.locationStatus === "GOOD";
    const headingReliable = this.headingUsable(timestampMs);
    const availability = this.engine.setGeographicAvailability({locationUsable,headingReliable},timestampMs);
    if (availability) this.latestNavigation = availability;
    const geographicState = !locationUsable
      ? "LOCATION_UNCERTAIN"
      : this.latestNavigation.geographicState ?? "ROUTE_MATCH_UNCERTAIN";
    this.renderPoseController.setNavigation(this.latestNavigation.routeProgressMeters,geographicState);
    this.latestQuality=this.renderPoseController.sampleDisplayFrame(timestampMs).quality;
    const snapshot: NavigationRuntimeSnapshot = {
      pose: {
        ...this.fusion.snapshot(timestampMs),
        quality: this.latestQuality,
        geographicState
      },
      navigation: {
        ...this.latestNavigation,
        trackingQuality: this.latestQuality,
        geographicState
      },
      geographic: {
        locationStatus: freshness.usable ? this.locationStatus : "REJECTED",
        locationReason: freshness.usable ? this.locationReason : "stale-location",
        locationAccuracyMeters: this.locationAccuracyMeters,
        locationAgeMs: freshness.ageMs,
        heading: this.latestHeading,
        headingAgeMs: this.latestHeading
          ? Math.max(0, timestampMs - this.latestHeading.timestampMs)
          : null,
        direction: this.routeDirection()
      }
    };
    const key=`${geographicState}/${this.latestQuality.state}`;
    if(force||timestampMs-this.lastUiUpdate>=200||key!==this.lastUiKey){this.options.onUpdate(snapshot);this.lastUiUpdate=timestampMs;this.lastUiKey=key;}
    return snapshot;
  }

  private headingUsable(now: number): boolean {
    const heading = this.latestHeading;
    return Boolean(this.geographicOrientationAvailable && heading?.usable &&
      heading.headingRad !== null && now >= heading.timestampMs && now-heading.timestampMs <= 2_000);
  }

  private routeDirection(): "left" | "right" | "behind" | "ahead" | null {
    const now = this.clock.monotonicNow();
    const heading = this.latestHeading;
    if (!this.latestPosition || !this.latestNavigation || !heading ||
      heading.headingRad === null || !this.headingUsable(now)) return null;
    const future = sampleRouteGroundPoint(
      this.options.groundRoute,
      this.latestNavigation.routeProgressMeters + 8
    );
    const world = applyMat4ToPoint(this.options.calibration.groundFromRoute, [
      future.rightMeters, 0, future.forwardMeters
    ]);
    const camera = this.fusion.snapshot(now).cameraPositionGroundMeters;
    const bearing = Math.atan2(world[0] - camera[0], world[2] - camera[2]);
    const error = Math.atan2(
      Math.sin(bearing - heading.headingRad),
      Math.cos(bearing - heading.headingRad)
    );
    return Math.abs(error) > Math.PI * 0.65
      ? "behind"
      : error > Math.PI / 6
        ? "right"
        : error < -Math.PI / 6
          ? "left"
          : "ahead";
  }
}

function inferRouteFrame(local: readonly LocalRoutePoint[], ground: readonly RouteGroundPoint[]): RouteFrame {
  const a=local[0]!,b=local[1]!,g=ground[0]!,h=ground[1]!;
  const bearing=Math.atan2(b.eastMeters-a.eastMeters,b.northMeters-a.northMeters)-
    Math.atan2(h.rightMeters-g.rightMeters,h.forwardMeters-g.forwardMeters);
  const c=Math.cos(bearing),s=Math.sin(bearing);
  return {tangentBearingRad:bearing,origin:{eastMeters:a.eastMeters-g.rightMeters*c-g.forwardMeters*s,
    northMeters:a.northMeters+g.rightMeters*s-g.forwardMeters*c,upMeters:a.upMeters-g.upMeters}};
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
