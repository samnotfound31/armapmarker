import { describe, expect, it, vi, type Mock } from "vitest";
import type { Mat3 } from "../domain/types";
import { OpenCvTracker, type CvAllocation, type OpenCvAdapter } from "./OpenCvTracker";

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
