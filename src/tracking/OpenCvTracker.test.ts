import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Mat3 } from "../domain/types";
import { applyMat3ToPixel } from "../geometry/displayTransform";
import {
  hasSpatialSupport,
  loadOpenCvTracker,
  OpenCvTracker,
  toFullImageHomography,
  type CvAllocation,
  type OpenCvAdapter
} from "./OpenCvTracker";

const fakeOpenCvRuntime = vi.hoisted(() => ({
  cv: {} as Record<string, unknown>
}));

vi.mock("./openCvRuntime", () => ({ default: fakeOpenCvRuntime.cv }));

afterEach(() => vi.unstubAllGlobals());

const SENSOR_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("OpenCvTracker candidate ownership", () => {
  it("retains the accepted image through rejected or stale candidates", async()=>{
    const fake=createFakeAdapter({homographies:[[1,0,0,0,1,0,2,0,1],[1,0,0,0,1,0,50,0,1],[1,0,0,0,1,0,4,0,1]]});
    const tracker=new OpenCvTracker(fake.adapter);
    await tracker.process({} as ImageBitmap,0); tracker.commit(0,true);
    await tracker.process({} as ImageBitmap,100); tracker.commit(100,true);
    const rejected=await tracker.process({} as ImageBitmap,200);tracker.commit(200,false);
    expect(rejected.keyframeId).toBe(1);
    const next=await tracker.process({} as ImageBitmap,300);
    expect((fake.adapter.track as Mock).mock.calls.at(-1)?.[0].opaque).toEqual({frameIndex:1});
    expect(next.visualHomography?.[6]).toBeCloseTo(4);
    tracker.commit(300,true);tracker.dispose();
    expect(fake.firstFrameResources.every(r=>r.delete.mock.calls.length===1)).toBe(true);
  });
  it("promotes a retained image only after explicit fresh acceptance",async()=>{
    const fake=createFakeAdapter();const tracker=new OpenCvTracker(fake.adapter);
    await tracker.process({} as ImageBitmap,0);tracker.commit(0,true);
    await tracker.process({} as ImageBitmap,100);tracker.commit(100,false,true);
    expect((await tracker.process({} as ImageBitmap,200)).keyframeId).toBe(1);
    tracker.commit(200,true,true);
    expect((await tracker.process({} as ImageBitmap,300)).keyframeId).toBe(2);
    expect((fake.adapter.track as Mock).mock.calls.at(-1)?.[0].opaque).toEqual({frameIndex:3});
    tracker.dispose();
  });
  it("rejects unsupported clusters, lines and orientation flips",async()=>{
    const mask=new Uint8Array([1,1,1,1]);
    expect(hasSpatialSupport([10,10,90,10,10,90,90,90],mask,100,100)).toBe(true);
    expect(hasSpatialSupport([10,10,11,10,10,11,11,11],mask,100,100)).toBe(false);
    expect(hasSpatialSupport([10,50,30,50,60,50,90,50],mask,100,100)).toBe(false);
    const f=createFakeAdapter({homography:[-1,0,0,0,1,0,0,0,1]});const t=new OpenCvTracker(f.adapter);
    await t.process({} as ImageBitmap,0);t.commit(0,true);expect((await t.process({} as ImageBitmap,100)).status).toBe("lost");t.dispose();
  });
  it("cleans retained, rejected and pending image resources exactly once",async()=>{
    const f=createFakeAdapter({homography:null});const t=new OpenCvTracker(f.adapter);
    await t.process({} as ImageBitmap,0);t.commit(0,true);
    await t.process({} as ImageBitmap,100);t.commit(100,false);t.dispose();
    expect([...f.firstFrameResources,...f.secondFrameResources].every(r=>r.delete.mock.calls.length===1)).toBe(true);
    expect(f.estimateResources.every(r=>r.delete.mock.calls.length===1)).toBe(true);
  });
  it("releases a prepared frame if disposal happens during asynchronous preparation",async()=>{
    const f=createFakeAdapter();const original=f.adapter.prepareFrame;let resolve!:(v:Awaited<ReturnType<OpenCvAdapter["prepareFrame"]>>)=>void;
    f.adapter.prepareFrame=()=>new Promise(r=>resolve=r);const t=new OpenCvTracker(f.adapter),pending=t.process({} as ImageBitmap,0);t.dispose();resolve(await original({} as ImageBitmap));
    await expect(pending).rejects.toThrow(/disposed/);expect(f.firstFrameResources.every(r=>r.delete.mock.calls.length===1)).toBe(true);
  });
  it("initializes A to C from the accepted adjacent pair when B was rejected",async()=>{
    const f=createFakeAdapter(),t=new OpenCvTracker(f.adapter);
    f.adapter.trackAdjacent=vi.fn(()=>({resources:[],homography:[1,0,0,0,1,0,2,0,1] as Mat3,trackedFeatureCount:32,inlierCount:24,medianReprojectionErrorPx:1,motionValid:true}));
    await t.process({} as ImageBitmap,0);t.commit(0,true);
    await t.process({} as ImageBitmap,100);t.commit(100,true);
    await t.process({} as ImageBitmap,200);t.commit(200,false);
    await t.process({} as ImageBitmap,300);
    expect((f.adapter.trackAdjacent as Mock).mock.calls.at(-1)?.[0].opaque).toEqual({frameIndex:2});
    expect((f.adapter.track as Mock).mock.calls.at(-1)?.[2][6]).toBeCloseTo(6);
    t.dispose();
  });
  it("deletes ROI allocations when feature detection fails",async()=>{
    vi.stubGlobal("ImageData",class {readonly data:Uint8ClampedArray;constructor(readonly width:number,readonly height:number){this.data=new Uint8ClampedArray(width*height*4);}});
    const f=throwingDetectionRuntime();Object.assign(fakeOpenCvRuntime.cv,f.cv);const t=await loadOpenCvTracker();
    await expect(t.process(new ImageData(16,16),0,SENSOR_IDENTITY)).rejects.toThrow("synthetic feature detection failure");
    expect(f.allocations.every(a=>a.delete.mock.calls.length===1)).toBe(true);
  });
  it("conjugates ROI flow into full-image pixels",()=>{
    const roi:Mat3=[.5,0,0,0,.5,0,0,-100,1];
    const h=toFullImageHomography([1,0,0,0,1,0,5,10,1],roi,roi);
    expect(applyMat3ToPixel(h,{xPx:200,yPx:300})).toEqual({xPx:210,yPx:320});
  });
});

function createFakeAdapter(
  options: {
    homography?: Mat3 | null;
    homographies?: readonly (Mat3 | null)[];
    inlierCount?: number;
    throwOnTrack?: boolean;
  } = {}
) {
  const frameBundles: TestAllocation[][] = [];
  const estimateResources = [allocation(), allocation(), allocation(), allocation(), allocation()];
  let trackIndex = 0;
  const adapter: OpenCvAdapter = {
    prepareFrame: vi.fn(() => {
      const resources = [allocation(), allocation(), allocation()];
      frameBundles.push(resources);
      return {
        resources,
        candidateCount: 42,
        imageWidthPx: 1280,
        imageHeightPx: 720,
        trackingFromImage: SENSOR_IDENTITY,
        opaque: { frameIndex: frameBundles.length }
      };
    }),
    track: vi.fn(() => {
      if (options.throwOnTrack) throw new Error("synthetic OpenCV failure");
      const sequenceHomography = options.homographies?.[trackIndex];
      trackIndex += 1;
      const homography = options.homographies
        ? sequenceHomography ?? null
        : options.homography === undefined
          ? ([1, 0, 0, 0, 1, 0, 4, -1, 1] satisfies Mat3)
          : options.homography;
      return {
        resources: estimateResources,
        homography,
        trackedFeatureCount: 32,
        inlierCount: options.inlierCount ?? 24,
        medianReprojectionErrorPx: 1.2,
        motionValid: homography !== null
      };
    })
  };
  return {
    adapter,
    get firstFrameResources() {
      return frameBundles[0] ?? [];
    },
    get secondFrameResources() {
      return frameBundles[1] ?? [];
    },
    estimateResources
  };
}

type TestAllocation = CvAllocation & { delete: Mock<() => void> };

function allocation(): TestAllocation {
  return { delete: vi.fn<() => void>() };
}

function throwingDetectionRuntime() {
  type FakeRuntimeMat = {
    label: string;
    rows: number;
    cols: number;
    delete: Mock<() => void>;
    roi(rect: { width: number; height: number }): FakeRuntimeMat;
    clone(): FakeRuntimeMat;
  };
  const allocations: FakeRuntimeMat[] = [];
  class FakeMat implements FakeRuntimeMat {
    label = "unassigned";
    rows = 0;
    cols = 0;
    data = new Uint8Array(480*480);
    delete = vi.fn<() => void>();

    constructor() {
      allocations.push(this);
    }

    roi(rect: { width: number; height: number }): FakeRuntimeMat {
      const result = new FakeMat();
      result.label = "roi-header";
      result.rows = rect.height;
      result.cols = rect.width;
      return result;
    }

    clone(): FakeRuntimeMat {
      const result = new FakeMat();
      result.label = "gray-road-roi";
      result.rows = this.rows;
      result.cols = this.cols;
      return result;
    }
  }
  const cv = {
    Mat: FakeMat,
    Size: class {
      constructor(
        readonly width: number,
        readonly height: number
      ) {}
    },
    Rect: class {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly width: number,
        readonly height: number
      ) {}
    },
    COLOR_RGBA2GRAY: 1,
    INTER_AREA: 2,
    matFromImageData(image: ImageData) {
      const result = new FakeMat();
      result.label = "rgba";
      result.rows = image.height;
      result.cols = image.width;
      return result;
    },
    cvtColor(source: FakeRuntimeMat, destination: FakeRuntimeMat) {
      destination.label = "grayscale";
      destination.rows = source.rows;
      destination.cols = source.cols;
    },
    resize(
      _source: FakeRuntimeMat,
      destination: FakeRuntimeMat,
      size: { width: number; height: number }
    ) {
      destination.label = "resized";
      destination.rows = size.height;
      destination.cols = size.width;
    },
    goodFeaturesToTrack(
      _image: FakeRuntimeMat,
      features: FakeRuntimeMat
    ) {
      features.label = "features";
      throw new Error("synthetic feature detection failure");
    }
  };
  return {
    cv,
    allocations,
    allocation(label: string) {
      const result = allocations.find((candidate) => candidate.label === label);
      if (!result) throw new Error(`Missing ${label} allocation.`);
      return result;
    }
  };
}
