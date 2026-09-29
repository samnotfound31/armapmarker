import { useEffect, useRef, useState } from "react";
import type { CameraIntrinsics, GroundCalibration, Mat3, Mat4, RouteGroundPoint } from "../domain/types";
import type { ScanObservation } from "../calibration/calibrationMachine";
import type { OrientationCalibrationSample } from "../geometry/groundCalibration";
import type { ImagePixel, Vec3 } from "../geometry/intrinsics";
import { estimateDemoGroundPose } from "../calibration/demoGroundPose";
import { buildRouteRibbon } from "../ar/routeRibbon";
import { projectRoutePointToScreen } from "../ar/projection";
import { PoseFusion } from "../pose/PoseFusion";
import type { AbsoluteHeadingReading } from "../device/orientation";

export type CalibrationFeed = {
  captureOrientation: (cameraHeightMeters?: 1.2 | 1.4 | 1.6) => Promise<{
    samples: readonly OrientationCalibrationSample[];
    cameraFromGroundAtLock: Mat4;
    earthFromGroundAtLock?: Mat3;
    absoluteHeading?: AbsoluteHeadingReading;
  }>;
  scanFeatures: () => Promise<readonly ScanObservation[]>;
};

type CalibrationScreenProps = {
  feed: CalibrationFeed;
  screenPointToGround: (point: ImagePixel, viewport?: {widthPx:number; heightPx:number}) => Vec3 | null;
  groundRoute: readonly RouteGroundPoint[];
  calibrationProgressMeters: number;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  onLock: (calibration: GroundCalibration) => void;
  onBack: () => void;
  stream?: MediaStream;
  routeBearingRad?: number;
  actualRoutePosition?: RouteGroundPoint;
};

export function CalibrationScreen(props: CalibrationScreenProps) {
  const {feed, stream, groundRoute, calibrationProgressMeters, intrinsics, imageToScreen} = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useRef(true);
  const tapping = useRef(false);
  const [capture, setCapture] = useState<Awaited<ReturnType<CalibrationFeed["captureOrientation"]>>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    active.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
      void Promise.resolve(video.play()).catch(() => undefined);
    }
    const refresh = async () => {
      if (stopped || tapping.current) return;
      try {
        const next = await feed.captureOrientation();
        if (!stopped && !tapping.current) { setCapture(next); setError(undefined); }
      } catch {
        if (!stopped) setError("Point toward the path and hold briefly while orientation becomes ready.");
      }
      if (!stopped && !tapping.current) timer = setTimeout(() => void refresh(), 700);
    };
    void refresh();
    return () => {
      active.current = false; stopped = true; clearTimeout(timer);
      if (video) video.srcObject = null;
    };
  }, [feed, stream]);

  const estimate = (value: NonNullable<typeof capture>, anchor?: Vec3) => estimateDemoGroundPose({
    groundRoute, progressMeters: calibrationProgressMeters, intrinsics, imageToScreen,
    capture: value, routeBearingRad:props.routeBearingRad, actualRoutePosition:props.actualRoutePosition,
    ...(anchor ? {anchor} : {})
  });
  let polygons: string[] = [];
  if (capture?.absoluteHeading?.usable) {
    try { const proposed=estimate(capture); if(proposed.geographicYawValidated) polygons = projectedMarkers(groundRoute, proposed); }
    catch { /* An unsafe provisional projection is not drawn. The tap explains it. */ }
  }
  const tap = async (point: ImagePixel, widthPx: number, heightPx: number) => {
    if (tapping.current || !capture) return;
    tapping.current = true; setBusy(true); setError(undefined);
    try {
      // Re-capture at the tap so a wrist movement during the preview cannot
      // leave a stale camera frame attached to the new alignment.
      const fresh = await feed.captureOrientation();
      if (!active.current) return;
      const anchor = props.screenPointToGround(point, {widthPx, heightPx});
      if (!anchor) throw new RangeError("Aim lower and tap visible ground a few metres ahead.");
      const calibration = estimate(fresh, anchor);
      props.onLock(calibration);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "Alignment could not start. Tap again.");
    } finally {
      tapping.current = false;
      if (active.current) setBusy(false);
    }
  };

  return <section className="quick-calibration" aria-labelledby="calibration-title">
    <video ref={videoRef} autoPlay muted playsInline className="calibration-camera" aria-label="Alignment camera view" />
    <button type="button" className="ground-anchor-surface" aria-label="Road calibration view"
      disabled={!capture || busy} onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        void tap({xPx:event.clientX-box.left, yPx:event.clientY-box.top}, box.width, box.height);
      }}>
      {capture && <svg role="img" aria-label="Approximate ground route" className="ghost-route"
        viewBox={`0 0 ${Math.max(1,window.innerWidth)} ${Math.max(1,window.innerHeight)}`}>
        {polygons.map((points,index) => <polygon key={index} points={points} />)}
      </svg>}
    </button>
    <div className="quick-calibration-card">
      <h2 id="calibration-title">Check the road view</h2>
      <p>{busy ? "Checking ground…" : capture ? "Hold naturally with ground in view. Tap visible ground once, or start guidance." : "Acquiring absolute heading…"}</p>
      <p className="status-line">{capture?.absoluteHeading?.usable ? "Geographic heading ready · Ground height is approximate" : "Heading unavailable or uncertain · AR tracers will stay hidden"}</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={!capture || busy} onClick={() => { if(capture) props.onLock(estimate(capture)); }}>Start guidance</button>
      <button type="button" className="text-button" onClick={props.onBack}>Back</button>
    </div>
  </section>;
}

function projectedMarkers(route: readonly RouteGroundPoint[], calibration: GroundCalibration): string[] {
  const ribbon = buildRouteRibbon(route, calibration.calibrationRouteDistanceMeters);
  const pose = new PoseFusion(calibration).snapshot(0);
  const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight);
  return ribbon.markers.flatMap((marker) => {
    const vertices = Array.from({length: marker.vertexCount}, (_, index) => {
      const offset = (marker.vertexOffset + index)*3;
      return projectRoutePointToScreen({rightMeters:ribbon.positions[offset]!, upMeters:ribbon.positions[offset+1]!,
        forwardMeters:ribbon.positions[offset+2]!, routeDistanceMeters:marker.routeDistanceMeters}, calibration, pose);
    });
    if (vertices.some((p) => !p) || !vertices.some((p) => p && p.xPx >= 0 && p.xPx <= width && p.yPx >= 0 && p.yPx <= height)) return [];
    return [vertices.map((p) => `${p!.xPx},${p!.yPx}`).join(" ")];
  });
}
