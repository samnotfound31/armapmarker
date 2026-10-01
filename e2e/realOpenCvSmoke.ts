import type { Mat3 } from "../src/domain/types";
import {RenderPoseController} from "../src/pose/RenderPoseController";
import {CameraFrameTimeline} from "../src/session/CameraFrameTimeline";
import {TrackingQualityGate} from "../src/tracking/quality";
import {buildApproximateIntrinsics} from "../src/geometry/intrinsics";
import {buildCameraFromGroundWithEarthFrame,GEOGRAPHIC_EARTH_FROM_GROUND} from "../src/geometry/groundCalibration";
import {invertHomography,multiplyHomographies} from "../src/tracking/residualHomography";
import {registrationDistance,warp} from "../src/pose/groundRegistration";
import type {GroundCalibration} from "../src/domain/types";
import {RouteRenderer} from "../src/ar/RouteRenderer";
import { loadOpenCvTracker } from "../src/tracking/OpenCvTracker";

type RuntimeSmokeResult = {
  status: "ready" | "tracked" | "error";
  securityViolations: string[];
  runtimeLoaded?: boolean;
  trackerResult?: {
    status: string;
    featureCount: number;
    inlierCount: number;
    qualityState: string;
    homography: Mat3 | null;
    coverage?:number;
    survivalRatio?:number;
    p90?:number;
    median?:number;
  };
  cleanupVerified?: boolean;
  sequence?:{frames:number;accepted:number;promotions:number;maximumResidualPx:number;maximumPromotionDeltaPx:number;recovered:boolean;changedMarkerAnchors:number;weakOpacity:number;diagnostics?:string[]};
  error?: string;
};

const status = document.querySelector<HTMLOutputElement>("#runtime-status")!;
const securityViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => {
  securityViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
});

void run();

async function run(): Promise<void> {
  let tracker: Awaited<ReturnType<typeof loadOpenCvTracker>> | null = null;
  try {
    tracker = await loadOpenCvTracker();
    const mode = new URLSearchParams(location.search).get("mode");
    if (mode === "initialize") {
      tracker.dispose();
      const cleanupVerified = await rejectsAfterDispose(
        tracker,
        new ImageData(1, 1),
        1000
      );
      publish({
        status: "ready",
        runtimeLoaded: true,
        cleanupVerified,
        securityViolations
      });
      return;
    }

    if(mode==="planar-motion"){
      const sequence=await planarSequence(tracker);
      tracker.dispose();publish({status:"tracked",runtimeLoaded:true,sequence,cleanupVerified:await rejectsAfterDispose(tracker,new ImageData(1,1),9000),securityViolations});return;
    }
    const [firstFrame, secondFrame] = deterministicProjectiveFrames();
    const gate=new TrackingQualityGate();
    await tracker.process(firstFrame,1000,IDENTITY);tracker.commit(1000,true);
    let result=await tracker.process(secondFrame,1100,IDENTITY);
    for(let index=0;index<5;index++){
      if(index)result=await tracker.process(secondFrame,1100+index*100,IDENTITY);
      const q=result.quality;const accepted=result.status==="tracked";
      gate.update({timestampMs:result.timestampMs,candidateCount:q.featureCount,inlierCount:q.inlierCount,medianReprojectionErrorPx:q.medianReprojectionErrorPx,motionValid:accepted},result.timestampMs);
      tracker.commit(result.timestampMs,accepted,accepted&&Boolean(result.promoteCandidate));
    }
    if (mode === "texture-loss") {
      const blank = new ImageData(firstFrame.width, firstFrame.height);
      for (let index = 0; index < 35; index++) {
        result = await tracker.process(blank,1600+index*100,IDENTITY);
        gate.update({timestampMs:result.timestampMs,candidateCount:0,inlierCount:0,medianReprojectionErrorPx:Infinity,motionValid:false},result.timestampMs);tracker.commit(result.timestampMs,false);
      }
    }
    tracker.dispose();
    const cleanupVerified = await rejectsAfterDispose(tracker, firstFrame, 1066);
    publish({
      status: "tracked",
      runtimeLoaded: true,
      trackerResult: {
        status: result.status,
        featureCount: result.quality.featureCount,
        inlierCount: result.quality.inlierCount,
        qualityState: gate.tick(result.timestampMs).state,
        homography: result.visualHomography,coverage:result.spatialCoverage,survivalRatio:result.quality.inlierCount/(result.originalFeatureCount??1),p90:result.p90ReprojectionErrorPx,median:result.quality.medianReprojectionErrorPx
      },
      cleanupVerified,
      securityViolations
    });
  } catch (error) {
    tracker?.dispose();
    publish({
      status: "error",
      securityViolations,
      error:
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error)
    });
  }
}

/** Real shipped LK/RANSAC path on a textured planar scene, with full nominal translation/rotation/bob. */
async function planarSequence(tracker:Awaited<ReturnType<typeof loadOpenCvTracker>>){
 const texture=planarTexture();const width=texture.width,height=texture.height;
 const camera=(t:number)=>buildCameraFromGroundWithEarthFrame({alphaRad:.015*Math.sin(t*.006),betaRad:1.4+.02*Math.sin(t*.011),gammaRad:.01*Math.sin(t*.011)},GEOGRAPHIC_EARTH_FROM_GROUND,[0,1.4,0]);
 const calibration:GroundCalibration={stage:"locked",cameraHeightMeters:1.4,intrinsics:buildApproximateIntrinsics(width,height),imageToScreen:IDENTITY,groundFromRoute:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],cameraFromGroundAtLock:camera(0),calibrationRouteDistanceMeters:0,lockedAtMs:0};
 const controller=new RenderPoseController(calibration),timeline=new CameraFrameTimeline();
 const context=(time:number)=>controller.captureFrame(timeline.stamp({nowMs:time,width,height,orientation:0}));
 const first=context(0),base=first.nominalPlane;
 const initial=await tracker.process(texture,0,IDENTITY,first);tracker.commit(0,controller.acceptTracking(initial,0));
 const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;document.body.append(canvas);
 const renderer=new RouteRenderer({canvas,calibration,route:[{rightMeters:0,upMeters:0,forwardMeters:0,routeDistanceMeters:0},{rightMeters:0,upMeters:0,forwardMeters:50,routeDistanceMeters:50}]});renderer.resize(width,height);
 const diagnostics:string[]=[];
 let accepted=0,promotions=0,maximumResidualPx=0,maximumPromotionDeltaPx=0,changedMarkerAnchors=0,weakOpacity=0,hadLoss=false,recovered=false;
 try{
  for(let index=1;index<=50;index++){
   const t=index*100;
   controller.updateRate([0,0,0],t);controller.updateSensor({timestampMs:t,cameraFromGround:camera(t),orientationQuaternion:[0,0,0,1]});
   controller.updateGps({timestampMs:t,cameraPositionGroundMeters:[0,1.4+.04*Math.sin(t*.011),t*.00025],routeProgressMeters:t*.00025},1);
   const current=context(t),observed=multiplyHomographies(current.nominalPlane,invertHomography(base));
   const blank=index>=20&&index<=23;const image=blank?new ImageData(width,height):warpTexture(texture,observed);
   const before=controller.sampleDisplayFrame(t);const candidate=await tracker.process(image,t,IDENTITY,current);
   const commit=controller.acceptTracking(candidate,t);tracker.commit(t,commit,commit&&Boolean(candidate.promoteCandidate));
   const pose=controller.sampleDisplayFrame(t);if(!blank&&!commit)diagnostics.push(`${index}:${candidate.status}:${controller.telemetry(t).lastRejection}:${candidate.quality.featureCount}/${candidate.quality.inlierCount}:${candidate.spatialCoverage}:${candidate.p90ReprojectionErrorPx}`);if(commit&&candidate.status==="tracked"){
    accepted++;maximumResidualPx=Math.max(maximumResidualPx,registrationDistance(IDENTITY,pose.visualCorrection.imageHomography,width,height));
    if(candidate.promoteCandidate){promotions++;maximumPromotionDeltaPx=Math.max(maximumPromotionDeltaPx,registrationDistance(before.visualCorrection.imageHomography,pose.visualCorrection.imageHomography,width,height));}
   }
   if(blank){hadLoss=true;weakOpacity=pose.overlayOpacity;}
   if(hadLoss&&!blank&&pose.quality.state==="locked")recovered=true;
   const projection=renderer.render(pose);changedMarkerAnchors=Math.max(changedMarkerAnchors,projection?.changedMarkerAnchors??0);
  }
 }finally{renderer.dispose();canvas.remove();}
 return {diagnostics,frames:50,accepted,promotions,maximumResidualPx,maximumPromotionDeltaPx,recovered,changedMarkerAnchors,weakOpacity};
}

// An unbounded virtual ground texture supplies newly visible road as the camera walks.
function planarPixel(x:number,y:number):number{
 const gridX=Math.floor(x/12),gridY=Math.floor(y/12),checker=(gridX+gridY)%2===0?70:24;
 const noise=((x*29+y*47+x*y*3)%31+31)%31-15;
 const squareX=((x-8)%20+20)%20,squareY=((y-98)%18+18)%18;
 return squareX<6&&squareY<6?220:checker+noise;
}
function planarTexture():ImageData{
 const image=new ImageData(320,240);for(let y=0;y<240;y++)for(let x=0;x<320;x++){const i=(y*320+x)*4,v=planarPixel(x,y);image.data[i]=v;image.data[i+1]=v;image.data[i+2]=v;image.data[i+3]=255;}return image;
}
function warpTexture(source:ImageData,mapping:Mat3):ImageData{
 const image=new ImageData(source.width,source.height),inverse=invertHomography(mapping);
 for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
  const [u,v]=warp(inverse,x,y),sx=Math.floor(u),sy=Math.floor(v),fx=u-sx,fy=v-sy,out=(y*image.width+x)*4;
  const value=(planarPixel(sx,sy)*(1-fx)+planarPixel(sx+1,sy)*fx)*(1-fy)+(planarPixel(sx,sy+1)*(1-fx)+planarPixel(sx+1,sy+1)*fx)*fy;
  image.data[out]=value;image.data[out+1]=value;image.data[out+2]=value;image.data[out+3]=255;
 }
 return image;
}

async function rejectsAfterDispose(
  tracker: Awaited<ReturnType<typeof loadOpenCvTracker>>,
  frame: ImageData,
  timestampMs: number
): Promise<boolean> {
  return tracker
    .process(frame, timestampMs, IDENTITY)
    .then(() => false)
    .catch((error: unknown) =>
      error instanceof Error && /disposed/i.test(error.message)
    );
}

function publish(result: RuntimeSmokeResult): void {
  window.__OPENCV_RUNTIME_SMOKE__ = result;
  status.dataset.status = result.status;
  status.textContent = JSON.stringify(result);
}

function deterministicProjectiveFrames(): [ImageData, ImageData] {
  const width = 320;
  const height = 240;
  const first = new ImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const gridX = Math.floor(x / 12);
      const gridY = Math.floor(y / 12);
      const checker = (gridX + gridY) % 2 === 0 ? 52 : 18;
      const speckle = ((x * 29 + y * 47 + x * y * 3) % 31) - 15;
      const roadTexture = y >= 88 ? checker + speckle : 24;
      first.data[offset] = roadTexture;
      first.data[offset + 1] = roadTexture;
      first.data[offset + 2] = roadTexture;
      first.data[offset + 3] = 255;
    }
  }
  for (let y = 98; y < height - 6; y += 18) {
    for (let x = 8; x < width - 6; x += 20) {
      drawSquare(first, x, y, 6, (x + y) % 40 === 0 ? 245 : 190);
    }
  }

  const sourceToDestination: Mat3 = [
    1.004, 0.006, 0.00012,
    0.004, 0.997, -0.00006,
    4, 2, 1
  ];
  const destinationToSource = invertFixtureHomography(sourceToDestination);
  const second = new ImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = transform(destinationToSource, x, y);
      const sourceX = Math.round(source.x);
      const sourceY = Math.round(source.y);
      const destinationOffset = (y * width + x) * 4;
      if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) {
        const sourceOffset = (sourceY * width + sourceX) * 4;
        second.data[destinationOffset] = first.data[sourceOffset]!;
        second.data[destinationOffset + 1] = first.data[sourceOffset + 1]!;
        second.data[destinationOffset + 2] = first.data[sourceOffset + 2]!;
      }
      second.data[destinationOffset + 3] = 255;
    }
  }
  return [first, second];
}

function drawSquare(
  image: ImageData,
  left: number,
  top: number,
  size: number,
  value: number
): void {
  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
    }
  }
}

function invertFixtureHomography(matrix: Mat3): Mat3 {
  const a = matrix[0];
  const b = matrix[3];
  const c = matrix[6];
  const d = matrix[1];
  const e = matrix[4];
  const f = matrix[7];
  const g = matrix[2];
  const h = matrix[5];
  const i = matrix[8];
  const determinant =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / determinant,
    (f * g - d * i) / determinant,
    (d * h - e * g) / determinant,
    (c * h - b * i) / determinant,
    (a * i - c * g) / determinant,
    (b * g - a * h) / determinant,
    (b * f - c * e) / determinant,
    (c * d - a * f) / determinant,
    (a * e - b * d) / determinant
  ];
}

function transform(matrix: Mat3, x: number, y: number) {
  const denominator = matrix[2] * x + matrix[5] * y + matrix[8];
  return {
    x: (matrix[0] * x + matrix[3] * y + matrix[6]) / denominator,
    y: (matrix[1] * x + matrix[4] * y + matrix[7]) / denominator
  };
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

declare global {
  interface Window {
    __OPENCV_RUNTIME_SMOKE__?: RuntimeSmokeResult;
  }
}
