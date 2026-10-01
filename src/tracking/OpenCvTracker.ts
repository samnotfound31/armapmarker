import { STABILIZATION_CONFIG } from "../pose/stabilizationConfig";
import type { Mat3 } from "../domain/types";
import type { CV, Mat } from "@techstark/opencv-js";
import {
  invertHomography,
  multiplyHomographies,
  normalizeHomography
} from "./residualHomography";
import type { TrackerResult, TrackingFrameContext } from "./types";

export type CvAllocation = {
  delete(): void;
};

export type PreparedCvFrame = {
  resources: readonly CvAllocation[];
  candidateCount: number;
  imageWidthPx: number;
  imageHeightPx: number;
  trackingFromImage: Mat3;
  sharpness?: number;
  opaque: unknown;
};

export type CvTrackEstimate = {
  resources: readonly CvAllocation[];
  homography: Mat3 | null;
  trackedFeatureCount: number;
  inlierCount: number;
  medianReprojectionErrorPx: number;
  motionValid: boolean;
  originalFeatureCount?:number;
  spatialCoverage?:number;
  p90ReprojectionErrorPx?:number;
  symmetricTransferErrorPx?:number;
};

export type OpenCvAdapter = {
  prepareFrame(frame: ImageBitmap | ImageData, roadRoiTopRatio?:number): PreparedCvFrame | Promise<PreparedCvFrame>;
  track(
    previousFrame: PreparedCvFrame,
    currentFrame: PreparedCvFrame,
    initialImageHomography?:Mat3
  ): CvTrackEstimate | Promise<CvTrackEstimate>;
  trackAdjacent?(previous:PreparedCvFrame,current:PreparedCvFrame):CvTrackEstimate|Promise<CvTrackEstimate>;
};

type OpenCvFrameOpaque = {
  grayRoadRoi: Mat;
  features: Mat;
};

const OPENCV_CONFIG = {
  maxFrameWidthPx: 480,
  roadRoiTopRatio: 0.38,
  maxFeatures: 120,
  featureQuality: 0.01,
  minimumFeatureDistancePx: 8,
  forwardBackwardErrorPx: 1.5,
  ransacReprojectionThresholdPx: 3
} as const;

const IDENTITY_HOMOGRAPHY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Image measurements are staged. Only an explicit fresh-result acknowledgement owns reference promotion. */
export class OpenCvTracker {
 private keyframe:PreparedCvFrame|null=null;
 private keyframeTime=0;
 private keyframeContext:TrackingFrameContext|undefined;
 private previous:PreparedCvFrame|null=null;
 private previousMapping:Mat3|null=null;
 private keyframeId=1;
 private pending:{frame:PreparedCvFrame;time:number;result:TrackerResult}|null=null;
 private disposed=false;
 constructor(private readonly adapter:OpenCvAdapter){}
 async process(frame:ImageBitmap|ImageData,timestampMs:number,_sensorHomography?:Mat3,context?:TrackingFrameContext):Promise<TrackerResult>{
  if(this.disposed)throw new Error("OpenCV tracker is disposed.");
  if(this.pending)this.commit(this.pending.time,false);
  const current=await this.adapter.prepareFrame(frame,context?.roadRoiTopRatio);
  if(this.disposed){deleteAllocations(current.resources);throw new Error("OpenCV tracker is disposed.");}
  if(context&&(current.imageWidthPx!==context.width||current.imageHeightPx!==context.height)){deleteAllocations(current.resources);return {status:"lost",timestampMs,keyframeId:this.keyframeId,context,visualHomography:null,quality:{state:"weak",featureCount:0,inlierCount:0,inlierRatio:0,medianReprojectionErrorPx:Infinity,rejectionReason:"image-dimensions-mismatch"}};}
  const reference=this.keyframe;
  let estimate:CvTrackEstimate|null=null;
  let adjacent:CvTrackEstimate|null=null;
  try{
   let observed:Mat3|null=null;
   const incompatible=reference&&context&&this.keyframeContext&&context.cameraGeneration!==this.keyframeContext.cameraGeneration;
   const expired=reference&&(incompatible||timestampMs-this.keyframeTime>STABILIZATION_CONFIG.keyframeMaximumAgeMs);
   const reacquire=expired&&current.candidateCount>=30&&(current.sharpness??10)>=5;
   if(reference&&!reacquire){
    let initializer:Mat3|undefined;
    if(this.previous&&this.previous!==reference&&this.previousMapping&&this.adapter.trackAdjacent){
     adjacent=await this.adapter.trackAdjacent(this.previous,current);
     if(adjacent.motionValid&&adjacent.homography)initializer=multiplyHomographies(toFullImageHomography(adjacent.homography,this.previous.trackingFromImage,current.trackingFromImage),this.previousMapping);
    }
    if(!initializer&&context&&this.keyframeContext)initializer=multiplyHomographies(context.nominalPlane,invertHomography(this.keyframeContext.nominalPlane));
    estimate=await this.adapter.track(reference,current,initializer);
    if(estimate.motionValid&&estimate.homography&&estimate.inlierCount>=15&&estimate.trackedFeatureCount>=15&&estimate.inlierCount/estimate.trackedFeatureCount>=.55&&estimate.medianReprojectionErrorPx<=3){
     try{
      observed=toFullImageHomography(estimate.homography,reference.trackingFromImage,current.trackingFromImage);
      invertHomography(observed);
      if(observed[0]*observed[4]-observed[1]*observed[3]<=0)observed=null;
     }catch(error){if(!(error instanceof RangeError))throw error;}
    }
   }
   const result:TrackerResult={context,status:reference&&!reacquire?(observed?"tracked":"lost"):"initializing",timestampMs,keyframeId:this.keyframeId+(reacquire?1:0),visualHomography:observed,
    quality:{state:"weak",featureCount:estimate?.trackedFeatureCount??current.candidateCount,inlierCount:estimate?.inlierCount??0,inlierRatio:estimate&&estimate.trackedFeatureCount?estimate.inlierCount/estimate.trackedFeatureCount:0,medianReprojectionErrorPx:estimate?.medianReprojectionErrorPx??Infinity,visualUpdate:observed?"valid":reference?"rejected":"initializing",rejectionReason:reference&&!observed?"unsupported-ground-motion":undefined},
    originalFeatureCount:estimate?.originalFeatureCount??reference?.candidateCount??current.candidateCount,
    spatialCoverage:estimate?.spatialCoverage,
    p90ReprojectionErrorPx:estimate?.p90ReprojectionErrorPx,
    symmetricTransferErrorPx:estimate?.symmetricTransferErrorPx,
    sharpness:current.sharpness,
    referenceTimestampMs:reference?this.keyframeTime:timestampMs,
    promoteCandidate:Boolean(observed&&timestampMs-this.keyframeTime>=STABILIZATION_CONFIG.keyframeMinimumAgeMs&&(current.sharpness??10)>=5&&estimate&&estimate.inlierCount>=20&&estimate.inlierCount/estimate.trackedFeatureCount>=.65)
   };
   this.pending={frame:current,time:timestampMs,result};
   return result;
  }catch(error){deleteAllocations(current.resources);throw error;}
  finally{if(estimate)deleteAllocations(estimate.resources);if(adjacent)deleteAllocations(adjacent.resources);}
 }
 commit(timestampMs:number,accepted:boolean,promote=false):boolean{
  const pending=this.pending;
  if(!pending||pending.time!==timestampMs)return false;
  this.pending=null;
  if(accepted&&pending.result.status!=="lost"){
   if(this.previous&&this.previous!==this.keyframe)deleteAllocations(this.previous.resources);
   if(!this.keyframe||promote||pending.result.status==="initializing"){
    if(this.keyframe)deleteAllocations(this.keyframe.resources);
    this.keyframe=pending.frame;this.keyframeTime=timestampMs;this.keyframeContext=pending.result.context;
    this.keyframeId=pending.result.status==="initializing"?pending.result.keyframeId:this.keyframeId+1;
    this.previousMapping=IDENTITY_HOMOGRAPHY;
   }else this.previousMapping=pending.result.visualHomography;
   this.previous=pending.frame;
  }else deleteAllocations(pending.frame.resources);
  return true;
 }
 dispose(){if(this.disposed)return;this.disposed=true;if(this.pending)this.commit(this.pending.time,false);if(this.previous&&this.previous!==this.keyframe)deleteAllocations(this.previous.resources);if(this.keyframe)deleteAllocations(this.keyframe.resources);this.keyframe=null;this.previous=null;}
}

export async function loadOpenCvTracker(): Promise<OpenCvTracker> {
  const cv = await loadOpenCv();
  return new OpenCvTracker(new OpenCvJsAdapter(cv));
}

class OpenCvJsAdapter implements OpenCvAdapter {
  constructor(private readonly cv: CV) {}

  prepareFrame(frame: ImageBitmap | ImageData, roadRoiTopRatio?:number): PreparedCvFrame {
    const allocations: Mat[] = [];
    try {
      const imageData = readImageData(frame);
      const rgba = this.cv.matFromImageData(imageData);
      const grayscale = new this.cv.Mat();
      const resized = new this.cv.Mat();
      allocations.push(rgba, grayscale, resized);
      this.cv.cvtColor(rgba, grayscale, this.cv.COLOR_RGBA2GRAY);

      const scale = Math.min(1, OPENCV_CONFIG.maxFrameWidthPx / grayscale.cols);
      const width = Math.max(1, Math.round(grayscale.cols * scale));
      const height = Math.max(1, Math.round(grayscale.rows * scale));
      this.cv.resize(
        grayscale,
        resized,
        new this.cv.Size(width, height),
        0,
        0,
        this.cv.INTER_AREA
      );

      const roiTop = Math.min(
        height - 1,
        Math.max(0, Math.floor(height * (roadRoiTopRatio ?? OPENCV_CONFIG.roadRoiTopRatio)))
      );
      // LK keeps the full, equal-sized image and its real pyramid neighborhoods.
      // Only feature detection is restricted to ground; changing pitch must not
      // change image dimensions or introduce a synthetic black boundary.
      const grayRoadRoi = resized.clone();
      allocations.push(grayRoadRoi);
      const roiHeader=grayRoadRoi.roi(new this.cv.Rect(0,roiTop,width,height-roiTop));
      allocations.push(roiHeader);
      const features = detectGoodFeatures(this.cv, roiHeader);
      allocations.push(features);
      for(let index=1;index<features.data32F.length;index+=2)features.data32F[index]!+=roiTop;

      deleteAllocations([rgba, grayscale, resized,roiHeader]);
      return {
        resources: [grayRoadRoi, features],
        sharpness:imageSharpness(grayRoadRoi,roiTop),
        candidateCount: features.rows,
        imageWidthPx: imageData.width,
        imageHeightPx: imageData.height,
        trackingFromImage: [
          scale, 0, 0,
          0, scale, 0,
          0, 0, 1
        ],
        opaque: { grayRoadRoi, features } satisfies OpenCvFrameOpaque
      };
    } catch (error) {
      deleteAllocations(allocations);
      throw error;
    }
  }

  track(
    previousFrame: PreparedCvFrame,
    currentFrame: PreparedCvFrame,
    initialImageHomography?:Mat3
  ): CvTrackEstimate {
    const previous = assertOpenCvFrame(previousFrame.opaque);
    const current = assertOpenCvFrame(currentFrame.opaque);
    const resources: Mat[] = [];
    // An empty feature Mat is not a valid point array for optical flow.
    // Report tracking loss so the quality gate can request re-alignment.
    if (previous.features.rows === 0) return lostEstimate(resources, 0);
    try {
      const initial=initialImageHomography&&multiplyHomographies(currentFrame.trackingFromImage,multiplyHomographies(initialImageHomography,invertHomography(previousFrame.trackingFromImage)));
      const initialPoints=initial?Array.from(previous.features.data32F).map((_v,index,array)=>{
       const offset=index-index%2;const x=array[offset]!,y=array[offset+1]!;const d=initial[2]*x+initial[5]*y+initial[8];return index%2?(initial[1]*x+initial[4]*y+initial[7])/d:(initial[0]*x+initial[3]*y+initial[6])/d;
      }):null;
      const nextPoints = initialPoints?this.cv.matFromArray(previous.features.rows,1,this.cv.CV_32FC2,initialPoints):new this.cv.Mat();
      const forwardStatus = new this.cv.Mat();
      const forwardErrors = new this.cv.Mat();
      // Validate the actual forward pair around its original point, rather
      // than letting the reverse pyramid select another repeated road feature.
      const backwardPoints = previous.features.clone();
      const backwardStatus = new this.cv.Mat();
      const backwardErrors = new this.cv.Mat();
      resources.push(
        nextPoints,
        forwardStatus,
        forwardErrors,
        backwardPoints,
        backwardStatus,
        backwardErrors
      );
      this.cv.calcOpticalFlowPyrLK(
        previous.grayRoadRoi,
        current.grayRoadRoi,
        previous.features,
        nextPoints,
        forwardStatus,
        forwardErrors,
        new this.cv.Size(21,21),3,new this.cv.TermCriteria(this.cv.TermCriteria_EPS|this.cv.TermCriteria_COUNT,30,.01),
        initialPoints?this.cv.OPTFLOW_USE_INITIAL_FLOW:0
      );
      this.cv.calcOpticalFlowPyrLK(
        current.grayRoadRoi,
        previous.grayRoadRoi,
        nextPoints,
        backwardPoints,
        backwardStatus,
        backwardErrors,
        new this.cv.Size(21,21),3,new this.cv.TermCriteria(this.cv.TermCriteria_EPS|this.cv.TermCriteria_COUNT,30,.01),
        this.cv.OPTFLOW_USE_INITIAL_FLOW
      );

      const matches = collectForwardBackwardMatches(
        previous.features.data32F,
        nextPoints.data32F,
        backwardPoints.data32F,
        unsignedByteData(forwardStatus),
        unsignedByteData(backwardStatus),
        OPENCV_CONFIG.forwardBackwardErrorPx
      );
      if (matches.count < 4) {
        return lostEstimate(resources, matches.count);
      }

      const sourcePoints = this.cv.matFromArray(
        matches.count,
        1,
        this.cv.CV_32FC2,
        matches.source
      );
      const destinationPoints = this.cv.matFromArray(
        matches.count,
        1,
        this.cv.CV_32FC2,
        matches.destination
      );
      const inlierMask = new this.cv.Mat();
      resources.push(sourcePoints, destinationPoints, inlierMask);
      const homographyMat = this.cv.findHomography(
        sourcePoints,
        destinationPoints,
        this.cv.RANSAC,
        OPENCV_CONFIG.ransacReprojectionThresholdPx,
        inlierMask
      );
      resources.push(homographyMat);
      if (homographyMat.empty()) {
        return lostEstimate(resources, matches.count);
      }

      const homography = openCvHomographyToColumnMajor(homographyMat);
      const reprojectionErrors = calculateReprojectionErrors(
        matches.source,
        matches.destination,
        unsignedByteData(inlierMask),
        homography
      );
      const inlierCount = reprojectionErrors.length;
      const sourceSupport=groundCoverage(matches.source,unsignedByteData(inlierMask),previous.grayRoadRoi.cols,previous.grayRoadRoi.rows);
      const destinationSupport=groundCoverage(matches.destination,unsignedByteData(inlierMask),current.grayRoadRoi.cols,current.grayRoadRoi.rows);
      const inverse=invertHomography(homography);
      const backwards=calculateReprojectionErrors(matches.destination,matches.source,unsignedByteData(inlierMask),inverse);
      const sorted=[...reprojectionErrors].sort((a,b)=>a-b);
      const p90=sorted[Math.floor((sorted.length-1)*.9)]??Infinity;
      return {
        resources,
        originalFeatureCount:previous.features.rows,
        spatialCoverage:Math.min(sourceSupport,destinationSupport),
        p90ReprojectionErrorPx:p90,
        symmetricTransferErrorPx:median(backwards),
        homography,
        trackedFeatureCount: matches.count,
        inlierCount,
        medianReprojectionErrorPx: median(reprojectionErrors),
        motionValid: sourceSupport>=.33&&destinationSupport>=.33&&inlierCount/Math.max(1,previous.features.rows)>=.25&&p90<=4&&median(backwards)<=3&&hasSpatialSupport(matches.destination, unsignedByteData(inlierMask),
          current.grayRoadRoi.cols, current.grayRoadRoi.rows) && isPlausibleMotion(
          homography,
          current.grayRoadRoi.cols,
          current.grayRoadRoi.rows
        )
      };
    } catch (error) {
      deleteAllocations(resources);
      throw error;
    }
  }
  trackAdjacent(previous:PreparedCvFrame,current:PreparedCvFrame):CvTrackEstimate{return this.track(previous,current);}
}

export function toFullImageHomography(
  trackingHomography: Mat3,
  previousTrackingFromImage: Mat3,
  currentTrackingFromImage: Mat3
): Mat3 {
  return normalizeHomography(
    multiplyHomographies(
      invertHomography(currentTrackingFromImage),
      multiplyHomographies(trackingHomography, previousTrackingFromImage)
    )
  );
}

async function loadOpenCv(): Promise<CV> {
  const imported = await import("./openCvRuntime");
  const moduleValue = unwrapDefaultExport(imported);
  const candidate = moduleValue instanceof Promise
    ? await moduleValue as CV
    : moduleValue as CV;
  if (candidate.Mat) return candidate;

  await new Promise<void>((resolve, reject) => {
    const runtime = candidate as CV & { onRuntimeInitialized?: () => void };
    const timeout = globalThis.setTimeout(
      () => reject(new Error("OpenCV initialization timed out.")),
      15_000
    );
    runtime.onRuntimeInitialized = () => {
      globalThis.clearTimeout(timeout);
      resolve();
    };
  });
  if (!candidate.Mat) throw new Error("OpenCV runtime is unavailable.");
  return candidate;
}

function unwrapDefaultExport(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      break;
    }
    const next = (current as { default?: unknown }).default;
    if (next === undefined || next === current) break;
    current = next;
  }
  return current;
}

function readImageData(frame: ImageBitmap | ImageData): ImageData {
  if (typeof ImageData !== "undefined" && frame instanceof ImageData) return frame;
  const bitmap = frame as ImageBitmap;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("A 2D canvas is required for visual tracking.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("A 2D canvas is required for visual tracking.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  throw new Error("Canvas frame extraction is unavailable in this browser.");
}

function assertOpenCvFrame(value: unknown): OpenCvFrameOpaque {
  if (!value || typeof value !== "object") {
    throw new TypeError("OpenCV frame state is invalid.");
  }
  return value as OpenCvFrameOpaque;
}

function unsignedByteData(matrix: Mat): Uint8Array {
  const runtimeMatrix = matrix as Mat & {
    data8U?: Uint8Array;
    data?: Uint8Array;
  };
  const data = runtimeMatrix.data8U ?? runtimeMatrix.data;
  if (!data) throw new Error("OpenCV returned no unsigned-byte matrix data.");
  return data;
}

type RuntimeFeatureDetector = CvAllocation & {
  detect(image: Mat, keypoints: RuntimeKeyPointVector): void;
};

type RuntimeKeyPointVector = CvAllocation & {
  size(): number;
  get(index: number): { pt: { x: number; y: number } };
};

type CvWithRuntimeFeatureDetector = CV & {
  GFTTDetector?: new (
    maxFeatures: number,
    qualityLevel: number,
    minimumDistancePx: number
  ) => RuntimeFeatureDetector;
  KeyPointVector?: new () => RuntimeKeyPointVector;
};

function detectGoodFeatures(cv: CV, image: Mat): Mat {
  if (typeof cv.goodFeaturesToTrack === "function") {
    const features = new cv.Mat();
    try {
      cv.goodFeaturesToTrack(
        image,
        features,
        OPENCV_CONFIG.maxFeatures,
        OPENCV_CONFIG.featureQuality,
        OPENCV_CONFIG.minimumFeatureDistancePx
      );
      return features;
    } catch (error) {
      features.delete();
      throw error;
    }
  }

  const runtime = cv as CvWithRuntimeFeatureDetector;
  if (!runtime.GFTTDetector || !runtime.KeyPointVector) {
    throw new Error("This OpenCV runtime has no supported road-feature detector.");
  }
  const detector = new runtime.GFTTDetector(
    OPENCV_CONFIG.maxFeatures,
    OPENCV_CONFIG.featureQuality,
    OPENCV_CONFIG.minimumFeatureDistancePx
  );
  const keypoints = new runtime.KeyPointVector();
  try {
    detector.detect(image, keypoints);
    const pointData: number[] = [];
    for (let index = 0; index < keypoints.size(); index += 1) {
      const point = keypoints.get(index).pt;
      pointData.push(point.x, point.y);
    }
    return cv.matFromArray(
      pointData.length / 2,
      1,
      cv.CV_32FC2,
      pointData
    );
  } finally {
    keypoints.delete();
    detector.delete();
  }
}

function collectForwardBackwardMatches(
  previousPoints: Float32Array,
  nextPoints: Float32Array,
  backwardPoints: Float32Array,
  forwardStatus: Uint8Array,
  backwardStatus: Uint8Array,
  maximumErrorPx: number
): { source: number[]; destination: number[]; count: number } {
  const source: number[] = [];
  const destination: number[] = [];
  const pointCount = Math.min(
    forwardStatus.length,
    backwardStatus.length,
    Math.floor(previousPoints.length / 2),
    Math.floor(nextPoints.length / 2),
    Math.floor(backwardPoints.length / 2)
  );
  for (let index = 0; index < pointCount; index += 1) {
    if (!forwardStatus[index] || !backwardStatus[index]) continue;
    const offset = index * 2;
    const previousX = previousPoints[offset]!;
    const previousY = previousPoints[offset + 1]!;
    const nextX = nextPoints[offset]!;
    const nextY = nextPoints[offset + 1]!;
    const backwardX = backwardPoints[offset]!;
    const backwardY = backwardPoints[offset + 1]!;
    const values = [previousX, previousY, nextX, nextY, backwardX, backwardY];
    if (values.some((value) => !Number.isFinite(value))) continue;
    if (Math.hypot(backwardX - previousX, backwardY - previousY) > maximumErrorPx) {
      continue;
    }
    source.push(previousX, previousY);
    destination.push(nextX, nextY);
  }
  return { source, destination, count: source.length / 2 };
}

function openCvHomographyToColumnMajor(matrix: Mat): Mat3 {
  const data = matrix.data64F.length >= 9 ? matrix.data64F : matrix.data32F;
  if (data.length < 9) throw new RangeError("OpenCV returned an invalid homography.");
  return [
    data[0]!, data[3]!, data[6]!,
    data[1]!, data[4]!, data[7]!,
    data[2]!, data[5]!, data[8]!
  ];
}

function calculateReprojectionErrors(
  source: readonly number[],
  destination: readonly number[],
  mask: Uint8Array,
  homography: Mat3
): number[] {
  const errors: number[] = [];
  for (let index = 0; index < source.length / 2; index += 1) {
    if (!mask[index]) continue;
    const offset = index * 2;
    const x = source[offset]!;
    const y = source[offset + 1]!;
    const divisor = homography[2] * x + homography[5] * y + homography[8];
    if (Math.abs(divisor) < 1e-9) continue;
    const projectedX =
      (homography[0] * x + homography[3] * y + homography[6]) / divisor;
    const projectedY =
      (homography[1] * x + homography[4] * y + homography[7]) / divisor;
    errors.push(
      Math.hypot(
        projectedX - destination[offset]!,
        projectedY - destination[offset + 1]!
      )
    );
  }
  return errors;
}

function isPlausibleMotion(matrix: Mat3, width: number, height: number): boolean {
  if (matrix.some((value) => !Number.isFinite(value))) return false;
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[7] * matrix[5]) -
    matrix[3] * (matrix[1] * matrix[8] - matrix[7] * matrix[2]) +
    matrix[6] * (matrix[1] * matrix[5] - matrix[4] * matrix[2]);
  const displacement = Math.hypot(matrix[6], matrix[7]);
  return (
    Math.abs(determinant) > 1e-8 &&
    Math.abs(matrix[2]) < 0.02 &&
    Math.abs(matrix[5]) < 0.02 &&
    displacement <= Math.max(width, height) * 0.75
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function lostEstimate(
  resources: readonly CvAllocation[],
  trackedFeatureCount: number
): CvTrackEstimate {
  return {
    resources,
    homography: null,
    trackedFeatureCount,
    inlierCount: 0,
    medianReprojectionErrorPx: Number.POSITIVE_INFINITY,
    motionValid: false
  };
}


function deleteAllocations(allocations: readonly CvAllocation[]): void {
  const uniqueAllocations = new Set(allocations);
  for (const allocation of uniqueAllocations) allocation.delete();
}

// A homography fitted to a tiny patch or an almost straight line does not
// constrain the whole ground image, even with an apparently good inlier ratio.
export function hasSpatialSupport(points: readonly number[], mask: Uint8Array, width: number, height: number): boolean {
  const xs: number[] = [], ys: number[] = [];
  for (let i=0;i<mask.length;i++) {
    if (mask[i] && Number.isFinite(points[2*i]) && Number.isFinite(points[2*i+1])) {
      xs.push(points[2*i]! / width); ys.push(points[2*i+1]! / height);
    }
  }
  if (xs.length < 4) return false;
  const spreadX = Math.max(...xs) - Math.min(...xs), spreadY = Math.max(...ys) - Math.min(...ys);
  const meanX = xs.reduce((s,x) => s+x,0)/xs.length, meanY = ys.reduce((s,y) => s+y,0)/ys.length;
  let xx=0, yy=0, xy=0;
  for (let i=0;i<xs.length;i++) {
    const dx=xs[i]!-meanX, dy=ys[i]!-meanY;
    xx+=dx*dx; yy+=dy*dy; xy+=dx*dy;
  }
  return spreadX >= 0.1 && spreadY >= 0.1 && spreadX*spreadY >= 0.025 && xx*yy-xy*xy > 0.01*xx*yy;
}

function imageSharpness(image:Mat,roiTop=0):number{const data=unsignedByteData(image);let sum=0,count=0;for(let y=Math.max(1,roiTop+1);y<image.rows;y+=3)for(let x=1;x<image.cols;x+=3){const i=y*image.cols+x;sum+=Math.abs(data[i]!-data[i-1]!)+Math.abs(data[i]!-data[i-image.cols]!);count+=2;}return count?sum/count:0;}
export function groundCoverage(points:readonly number[],mask:Uint8Array,width:number,height:number):number{const cells=new Set<number>();for(let i=0;i<mask.length;i++)if(mask[i]){const x=points[i*2]!,y=points[i*2+1]!;if(x>=0&&x<width&&y>=0&&y<height)cells.add(Math.floor(x/width*3)+3*Math.floor(y/height*4));}return cells.size/12;}
