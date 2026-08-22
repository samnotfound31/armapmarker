import { describe, expect, it, vi, type Mock } from "vitest";
import type { Mat3 } from "../domain/types";
import { applyMat3ToPixel } from "../geometry/displayTransform";
import {
  OpenCvTracker,
  toFullImageHomography,
  type CvAllocation,
  type OpenCvAdapter
} from "./OpenCvTracker";

const SENSOR_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("OpenCvTracker", () => {
  it("disposes superseded frame and estimate Mats after successful tracking", async () => {
    const fake = createFakeAdapter();
    const tracker = new OpenCvTracker(fake.adapter);

    await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    const result = await tracker.process({} as ImageBitmap, 1033, SENSOR_IDENTITY);

    expect(result.status).toBe("tracked");
    expect(result.quality.inlierCount).toBe(24);
    expect(fake.firstFrameResources.every((resource) => resource.delete.mock.calls.length === 1)).toBe(true);
    expect(fake.estimateResources.every((resource) => resource.delete.mock.calls.length === 1)).toBe(true);

    tracker.dispose();
    expect(fake.secondFrameResources.every((resource) => resource.delete.mock.calls.length === 1)).toBe(true);
  });

  it("reports tracking loss and still deletes estimate Mats", async () => {
    const fake = createFakeAdapter({ homography: null, inlierCount: 0 });
    const tracker = new OpenCvTracker(fake.adapter);

    await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    const result = await tracker.process({} as ImageBitmap, 1033, SENSOR_IDENTITY);

    expect(result.status).toBe("lost");
    expect(fake.estimateResources.every((resource) => resource.delete.mock.calls.length === 1)).toBe(true);
    tracker.dispose();
  });

  it("deletes retained and current Mats when the adapter throws", async () => {
    const fake = createFakeAdapter({ throwOnTrack: true });
    const tracker = new OpenCvTracker(fake.adapter);

    await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    await expect(tracker.process({} as ImageBitmap, 1033, SENSOR_IDENTITY)).rejects.toThrow(
      "synthetic OpenCV failure"
    );

    expect(fake.firstFrameResources.every((resource) => resource.delete.mock.calls.length === 1)).toBe(true);
    expect(fake.secondFrameResources.every((resource) => resource.delete.mock.calls.length === 1)).toBe(true);
  });

  it("deletes frame Mats once when residual composition rejects sensor input", async () => {
    const fake = createFakeAdapter();
    const tracker = new OpenCvTracker(fake.adapter);
    const singular: Mat3 = [1, 0, 0, 0, 0, 0, 0, 0, 1];

    await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    await expect(
      tracker.process({} as ImageBitmap, 1033, singular)
    ).rejects.toThrow(/singular/i);

    expect(
      fake.firstFrameResources.every(
        (resource) => resource.delete.mock.calls.length === 1
      )
    ).toBe(true);
    expect(
      fake.secondFrameResources.every(
        (resource) => resource.delete.mock.calls.length === 1
      )
    ).toBe(true);
  });

  it("accumulates translation residuals against one retained keyframe", async () => {
    const fake = createFakeAdapter({
      homography: [1, 0, 0, 0, 1, 0, 3, -2, 1]
    });
    const tracker = new OpenCvTracker(fake.adapter);

    await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    const first = await tracker.process({} as ImageBitmap, 1033, SENSOR_IDENTITY);
    const second = await tracker.process({} as ImageBitmap, 1066, SENSOR_IDENTITY);

    expect(first.visualHomography).toEqual([
      expect.closeTo(1), expect.closeTo(0), 0,
      expect.closeTo(0), expect.closeTo(1), 0,
      expect.closeTo(3), expect.closeTo(-2), 1
    ]);
    expect(second.visualHomography).toEqual([
      expect.closeTo(1), expect.closeTo(0), 0,
      expect.closeTo(0), expect.closeTo(1), 0,
      expect.closeTo(6), expect.closeTo(-4), 1
    ]);
    expect(second.keyframeId).toBe(first.keyframeId);
  });

  it("removes rotation-only sensor motion across multiple frames", async () => {
    const rotation = 0.03;
    const rotationHomography: Mat3 = [
      Math.cos(rotation), Math.sin(rotation), 0,
      -Math.sin(rotation), Math.cos(rotation), 0,
      0, 0, 1
    ];
    const fake = createFakeAdapter({ homography: rotationHomography });
    const tracker = new OpenCvTracker(fake.adapter);

    await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    await tracker.process({} as ImageBitmap, 1033, rotationHomography);
    const result = await tracker.process({} as ImageBitmap, 1066, rotationHomography);

    expect(result.visualHomography).toEqual([
      expect.closeTo(1), expect.closeTo(0), 0,
      expect.closeTo(0), expect.closeTo(1), 0,
      expect.closeTo(0), expect.closeTo(0), 1
    ]);
  });

  it("conjugates resized ROI motion into full-image pixel coordinates", () => {
    const trackingFromImage: Mat3 = [
      0.5, 0, 0,
      0, 0.5, 0,
      0, -100, 1
    ];

    expect(
      toFullImageHomography(
        [1, 0, 0, 0, 1, 0, 5, 10, 1],
        trackingFromImage,
        trackingFromImage
      )
    ).toEqual([
      expect.closeTo(1), expect.closeTo(0), expect.closeTo(0),
      expect.closeTo(0), expect.closeTo(1), expect.closeTo(0),
      expect.closeTo(10), expect.closeTo(20), expect.closeTo(1)
    ]);

    const fullImageRotation = toFullImageHomography(
      [0, 1, 0, -1, 0, 0, 0, 0, 1],
      trackingFromImage,
      trackingFromImage
    );
    expect(
      applyMat3ToPixel(fullImageRotation, { xPx: 200, yPx: 300 })
    ).toEqual({
      xPx: expect.closeTo(-100),
      yPx: expect.closeTo(400)
    });
  });

  it("preserves accumulated correction on deliberate keyframe replacement", async () => {
    const fake = createFakeAdapter({
      homography: [1, 0, 0, 0, 1, 0, 2, 0, 1]
    });
    const tracker = new OpenCvTracker(fake.adapter, {
      keyframeReplacementIntervalFrames: 2
    });

    const initial = await tracker.process({} as ImageBitmap, 1000, SENSOR_IDENTITY);
    const first = await tracker.process({} as ImageBitmap, 1033, SENSOR_IDENTITY);
    const replacement = await tracker.process(
      {} as ImageBitmap,
      1066,
      SENSOR_IDENTITY
    );

    expect(first.keyframeId).toBe(initial.keyframeId);
    expect(replacement.keyframeId).toBe(initial.keyframeId + 1);
    expect(replacement.visualHomography?.[6]).toBeCloseTo(4);
  });
});

function createFakeAdapter(
  options: { homography?: Mat3 | null; inlierCount?: number; throwOnTrack?: boolean } = {}
) {
  const frameBundles: TestAllocation[][] = [];
  const estimateResources = [allocation(), allocation(), allocation(), allocation(), allocation()];
  const adapter: OpenCvAdapter = {
    prepareFrame: vi.fn(() => {
      const resources = [allocation(), allocation(), allocation()];
      frameBundles.push(resources);
      return {
        resources,
        candidateCount: 42,
        trackingFromImage: SENSOR_IDENTITY,
        opaque: { frameIndex: frameBundles.length }
      };
    }),
    track: vi.fn(() => {
      if (options.throwOnTrack) throw new Error("synthetic OpenCV failure");
      return {
        resources: estimateResources,
        homography:
          options.homography === undefined
            ? ([1, 0, 0, 0, 1, 0, 4, -1, 1] satisfies Mat3)
            : options.homography,
        trackedFeatureCount: 32,
        inlierCount: options.inlierCount ?? 24,
        medianReprojectionErrorPx: 1.2,
        motionValid: options.homography !== null
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
