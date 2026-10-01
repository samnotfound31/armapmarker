import { useEffect, useRef, useState } from "react";
import type { CameraIntrinsics, GroundCalibration, Mat3, Mat4, RouteGroundPoint } from "../domain/types";
import type { ScanObservation } from "../calibration/calibrationMachine";
import type { OrientationCalibrationSample } from "../geometry/groundCalibration";
import type { ImagePixel, Vec3 } from "../geometry/intrinsics";
import { estimateDemoGroundPose } from "../calibration/demoGroundPose";
import { buildRouteRibbon } from "../ar/routeRibbon";
import { projectRoutePointToScreen } from "../ar/projection";
import { RenderPoseController, type RenderPose } from "../pose/RenderPoseController";
import type { NavigationSessionAdapters } from "../session/NavigationSession";
import { createDisplayTransform, readScreenOrientationAngle, resolveDisplayRotation } from "../geometry/displayTransform";
import { AlignmentControls } from "./AlignmentControls";
import type { AbsoluteHeadingReading } from "../device/orientation";

export type CalibrationFeed = {
  captureOrientation: (cameraHeightMeters?: 1.2 | 1.4 | 1.6) => Promise<{
    samples: readonly OrientationCalibrationSample[];
    cameraFromGroundAtLock: Mat4;
    earthFromGroundAtLock?: Mat3;
    absoluteHeading?: AbsoluteHeadingReading;
  }>;
  scanFeatures: () => Promise<readonly ScanObservation[]>;
  createPresentationAdapters?: (calibration: GroundCalibration) => Pick<NavigationSessionAdapters, "sensor" | "motion" | "frames" | "bindVideo">;
};
type OrientationCapture = Awaited<ReturnType<CalibrationFeed["captureOrientation"]>>;

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
  const ghostRef = useRef<SVGSVGElement>(null);
  const liveRef = useRef<{controller:RenderPoseController;calibration:GroundCalibration;capture:OrientationCapture;pose:RenderPose|null} | null>(null);
  const active = useRef(true);
  const tapping = useRef(false);
  const [capture, setCapture] = useState<Awaited<ReturnType<CalibrationFeed["captureOrientation"]>>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [alignment,setAlignment]=useState({lateralMeters:0,yawRad:0});
  const alignmentRef=useRef(alignment);alignmentRef.current=alignment;
  const [headingReady,setHeadingReady]=useState(false);

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
        if (!stopped && !tapping.current) { setCapture(next); setHeadingReady(!feed.createPresentationAdapters&&next.absoluteHeading?.usable===true);setError(undefined); }
      } catch {
        if (!stopped) setError("Point toward the path and hold briefly while orientation becomes ready.");
      }
      if (!stopped && !tapping.current && !feed.createPresentationAdapters) timer = setTimeout(() => void refresh(), 700);
    };
    void refresh();
    return () => {
      active.current = false; stopped = true; clearTimeout(timer);
      if (video) video.srcObject = null;
    };
  }, [feed, stream]);

  const estimate = (value: NonNullable<typeof capture>, anchor?: Vec3):GroundCalibration => ({...estimateDemoGroundPose({
    groundRoute, progressMeters: calibrationProgressMeters, intrinsics, imageToScreen,
    capture: value, routeBearingRad:props.routeBearingRad, actualRoutePosition:props.actualRoutePosition,
    ...(anchor ? {anchor} : {})
  }),manualAlignment:alignment});
  useEffect(()=>{
    if(!capture||!feed.createPresentationAdapters||!ghostRef.current)return;
    const base=estimateDemoGroundPose({groundRoute,progressMeters:calibrationProgressMeters,intrinsics,imageToScreen,capture,
      routeBearingRad:props.routeBearingRad,actualRoutePosition:props.actualRoutePosition});
    const controller=new RenderPoseController(base);
    controller.setAlignmentEditing(true);
    const live={controller,calibration:base,capture,pose:null as RenderPose|null};
    liveRef.current=live;
    const adapters=feed.createPresentationAdapters(base);
    const headings:AbsoluteHeadingReading[] = capture.absoluteHeading?[capture.absoluteHeading]:[];
    let latestHeading=capture.absoluteHeading;
    let animationFrame=0,lastUi=-Infinity,stopped=false;
    const svg=ghostRef.current,ribbon=buildRouteRibbon(groundRoute,calibrationProgressMeters);
    const polygons=ribbon.markers.map(marker=>{
      const polygon=document.createElementNS("http://www.w3.org/2000/svg","polygon");
      polygon.dataset.markerId=marker.id;return polygon;
    });
    svg.replaceChildren(...polygons);
    const draw=(now:number)=>{
      if(stopped)return;
      const pose=controller.sampleDisplayFrame(now);
      if(live.pose){
        controller.setManualAlignment(alignmentRef.current);
        const k=pose.renderIntrinsics??intrinsics;
        const width=Math.max(1,window.innerWidth),height=Math.max(1,window.innerHeight);
        const display=createDisplayTransform({imageWidthPx:k.imageWidthPx,imageHeightPx:k.imageHeightPx,
          screenWidthPx:width,screenHeightPx:height,rotationDeg:resolveDisplayRotation(readScreenOrientationAngle(),k.imageWidthPx,k.imageHeightPx,width,height)});
        live.calibration={...base,intrinsics:k,imageToScreen:display.imageToScreen};
        live.pose=controller.sampleDisplayFrame(now);
        svg.setAttribute("viewBox",`0 0 ${width} ${height}`);
        const projected=projectedMarkers(groundRoute,live.calibration,live.pose);
        for(let index=0;index<polygons.length;index++){
          const points=projected.get(ribbon.markers[index]!.id);
          polygons[index]!.style.display=points?"":"none";
          if(points)polygons[index]!.setAttribute("points",points);
        }
        svg.style.opacity=String(live.pose.overlayOpacity);
      }else svg.style.opacity="0";
      if(now-lastUi>=200){setHeadingReady(live.pose?.geographicState==="VALID"&&live.pose.overlayOpacity>0&&now-live.pose.imageTime<=250);lastUi=now;}
    };
    const disposers=[adapters.sensor.subscribe(update=>{
      controller.updateSensor(update);
      const heading=update.absoluteHeading;
      latestHeading=heading&&["webkit-compass","absolute-alpha","unavailable"].includes(heading.source)
        ? {...heading,source:heading.source as AbsoluteHeadingReading["source"]}:undefined;
      if(!latestHeading?.usable)controller.setNavigation(calibrationProgressMeters,"HEADING_UNCERTAIN");
      if(latestHeading){headings.push(latestHeading);while(headings.length>1&&headings[0]!.timestampMs<update.timestampMs-2000)headings.shift();}
    }),adapters.frames.subscribe(sample=>{
      sample.frame?.close();
      if(!sample.stamp)return;
      controller.captureFrame(sample.stamp);
      const pose=controller.sampleDisplayFrame(performance.now());
      const heading=headings.findLast(value=>value.timestampMs<=pose.imageTime)??capture.absoluteHeading;
      live.capture={...capture,cameraFromGroundAtLock:pose.cameraFromGround,...(heading?{absoluteHeading:heading}:{})};
      live.pose=pose;
      const valid=latestHeading?.usable===true&&heading?.usable===true&&performance.now()-heading.timestampMs<=2000&&
        estimateDemoGroundPose({groundRoute,progressMeters:calibrationProgressMeters,intrinsics,imageToScreen,capture:live.capture,
          routeBearingRad:props.routeBearingRad,actualRoutePosition:props.actualRoutePosition}).geographicYawValidated===true;
      controller.setNavigation(calibrationProgressMeters,valid?"VALID":"HEADING_UNCERTAIN");
      draw(performance.now());
    })];
    if(adapters.motion)disposers.push(adapters.motion.subscribe(update=>controller.updateRate(update.rate,update.timestampMs)));
    adapters.bindVideo?.(videoRef.current);
    const animate=(now:number)=>{draw(now);animationFrame=requestAnimationFrame(animate);};
    animationFrame=requestAnimationFrame(animate);
    return ()=>{stopped=true;cancelAnimationFrame(animationFrame);for(const dispose of disposers)dispose();adapters.bindVideo?.(null);if(liveRef.current===live)liveRef.current=null;svg.replaceChildren();};
  },[capture,feed,groundRoute,calibrationProgressMeters,intrinsics,imageToScreen,props.routeBearingRad,props.actualRoutePosition]);
  let polygons: string[] = [];
  if (!feed.createPresentationAdapters && capture?.absoluteHeading?.usable) {
    try { const proposed=estimate(capture); if(proposed.geographicYawValidated) polygons = [...projectedMarkers(groundRoute, proposed).values()]; }
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
  const lock = async()=>{
    if(tapping.current||!capture)return;
    tapping.current=true;setBusy(true);setError(undefined);
    try{
      const live=liveRef.current;
      if(live){
        live.controller.setManualAlignment(alignmentRef.current);
        const pose=live.controller.sampleDisplayFrame(performance.now());
        if(!live.pose||performance.now()-pose.imageTime>250||pose.geographicState!=="VALID")
          throw new RangeError("Wait for a current camera image and reliable heading before locking alignment.");
        if(pose.overlayOpacity<=0)throw new RangeError("Keep the alignment within its allowance and wait for a reliable camera pose.");
        const calibration=estimate(live.capture);
        if(!calibration.geographicYawValidated)throw new RangeError("Hold briefly while heading and the camera agree.");
        props.onLock({...calibration,intrinsics:live.calibration.intrinsics,imageToScreen:live.calibration.imageToScreen,
          cameraFromGroundAtLock:pose.cameraFromGround,lockedAtMs:pose.imageTime});
      }else{
        const fresh=await feed.captureOrientation();
        if(active.current)props.onLock(estimate(fresh));
      }
    }catch(failure){if(active.current)setError(failure instanceof Error?failure.message:"Alignment could not lock. Try again.");}
    finally{tapping.current=false;if(active.current)setBusy(false);}
  };

  return <section className="quick-calibration" aria-labelledby="calibration-title">
    <video ref={videoRef} autoPlay muted playsInline className="calibration-camera" aria-label="Alignment camera view" />
    <button type="button" className="ground-anchor-surface" aria-label="Road calibration view"
      disabled={!capture || busy} onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        void tap({xPx:event.clientX-box.left, yPx:event.clientY-box.top}, box.width, box.height);
      }}>
      {capture && <svg ref={ghostRef} role="img" aria-label="Approximate ground route" className="ghost-route"
        viewBox={`0 0 ${Math.max(1,window.innerWidth)} ${Math.max(1,window.innerHeight)}`}>
        {polygons.map((points,index) => <polygon key={index} points={points} />)}
      </svg>}
    </button>
    <div className="quick-calibration-card">
      <h2 id="calibration-title">Check the road view</h2>
      <p>{busy ? "Checking ground…" : capture ? "Hold naturally with ground in view. Adjust the ghost slightly if needed, then lock alignment." : "Acquiring absolute heading…"}</p>
      <p className="status-line">{headingReady ? "Geographic heading ready · Ground height is approximate" : "Heading unavailable or uncertain · AR tracers will stay hidden"}</p>
      {error && <p role="alert">{error}</p>}
      {capture && !busy && <AlignmentControls initial={alignment} onChange={setAlignment} onLock={()=>void lock()} lockDisabled={Boolean(feed.createPresentationAdapters)&&!headingReady} />}
      <button type="button" className="text-button" onClick={props.onBack}>Back</button>
    </div>
  </section>;
}

function projectedMarkers(route: readonly RouteGroundPoint[], calibration: GroundCalibration, currentPose?:RenderPose): Map<string,string> {
  const ribbon = buildRouteRibbon(route, calibration.calibrationRouteDistanceMeters);
  const pose = currentPose??new RenderPoseController(calibration).sample(calibration.lockedAtMs??0);
  const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight);
  const result=new Map<string,string>();
  for(const marker of ribbon.markers){
    const vertices = Array.from({length: marker.vertexCount}, (_, index) => {
      const offset = (marker.vertexOffset + index)*3;
      return projectRoutePointToScreen({rightMeters:ribbon.positions[offset]!, upMeters:ribbon.positions[offset+1]!,
        forwardMeters:ribbon.positions[offset+2]!, routeDistanceMeters:marker.routeDistanceMeters}, calibration, pose);
    });
    if (vertices.some((p) => !p) || !vertices.some((p) => p && p.xPx >= 0 && p.xPx <= width && p.yPx >= 0 && p.yPx <= height)) continue;
    result.set(marker.id,vertices.map((p) => `${p!.xPx},${p!.yPx}`).join(" "));
  }
  return result;
}
