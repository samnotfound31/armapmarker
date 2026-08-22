import { describe, expect, it, vi } from "vitest";
import type { Mat3 } from "../domain/types";
import type { TrackerResult } from "./types";
import {
  TrackerClient,
  type MainThreadTracker,
  type TrackingWorkerLike
} from "./TrackerClient";

const SENSOR_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("TrackerClient", () => {
  it("allows one transferred frame in flight and drops the next", async () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new TrackerClient({
      workerFactory: () => worker,
      mainThreadFactory: vi.fn(),
      onResult,
      now: () => 1050
    });
    const first = fakeBitmap();
    const second = fakeBitmap();

    const start = client.start();
    worker.emit({ type: "ready" });
    await start;
    expect(client.submitFrame(first.bitmap, 1000, SENSOR_IDENTITY)).toBe(true);
    expect(client.submitFrame(second.bitmap, 1010, SENSOR_IDENTITY)).toBe(false);
    expect(second.close).toHaveBeenCalledOnce();
    expect(worker.posts[1]?.transfer).toEqual([first.bitmap]);

    worker.emit({ type: "result", result: trackedResult(1000) });
    expect(onResult).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("drops stale worker results older than 250 milliseconds", async () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new TrackerClient({
      workerFactory: () => worker,
      mainThreadFactory: vi.fn(),
      onResult,
      now: () => 1251
    });

    const start = client.start();
    worker.emit({ type: "ready" });
    await start;
    client.submitFrame(fakeBitmap().bitmap, 1000, SENSOR_IDENTITY);
    worker.emit({ type: "result", result: trackedResult(1000) });

    expect(onResult).not.toHaveBeenCalled();
    client.dispose();
  });

  it("terminates and reports a worker that becomes unavailable after startup", async () => {
    const worker = new FakeWorker();
    const onUnavailable = vi.fn();
    const client = new TrackerClient({
      workerFactory: () => worker,
      mainThreadFactory: vi.fn(),
      onResult: vi.fn(),
      onUnavailable
    });
    const start = client.start();
    worker.emit({ type: "ready" });
    await start;

    worker.emit({ type: "unavailable", message: "Worker tracking failed" });

    expect(client.status).toBe("unavailable");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith("Worker tracking failed");
  });

  it("uses reduced-cadence main-thread tracking without worker support", async () => {
    const process = vi.fn(async (_frame, timestampMs) => trackedResult(timestampMs));
    const dispose = vi.fn();
    const tracker: MainThreadTracker = { process, dispose };
    const onResult = vi.fn();
    let nowMs = 1000;
    const client = new TrackerClient({
      workerFactory: null,
      mainThreadFactory: async () => tracker,
      onResult,
      now: () => nowMs,
      mainThreadIntervalMs: 100
    });
    await client.start();

    const first = fakeBitmap();
    expect(client.submitFrame(first.bitmap, 1000, SENSOR_IDENTITY)).toBe(true);
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    nowMs = 1050;
    expect(client.submitFrame(fakeBitmap().bitmap, 1050, SENSOR_IDENTITY)).toBe(false);
    nowMs = 1100;
    expect(client.submitFrame(fakeBitmap().bitmap, 1100, SENSOR_IDENTITY)).toBe(true);
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));

    client.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("terminates a failed worker and falls back to main-thread tracking once", async () => {
    const worker = new FakeWorker();
    const onUnavailable = vi.fn();
    const tracker: MainThreadTracker = {
      process: vi.fn(async (_frame, timestampMs) => trackedResult(timestampMs)),
      dispose: vi.fn()
    };
    const mainThreadFactory = vi.fn(async () => tracker);
    const client = new TrackerClient({
      workerFactory: () => worker,
      mainThreadFactory,
      onResult: vi.fn(),
      onUnavailable
    });

    const start = client.start();
    worker.emit({ type: "unavailable", message: "OpenCV could not initialize" });

    await expect(start).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mainThreadFactory).toHaveBeenCalledOnce();
    expect(client.status).toBe("ready");
    expect(onUnavailable).not.toHaveBeenCalled();
    client.dispose();
  });

  it("reports unavailable only after worker and main-thread initialization both fail", async () => {
    const worker = new FakeWorker();
    const onUnavailable = vi.fn();
    const mainThreadFactory = vi.fn(async () => {
      throw new Error("Main-thread OpenCV failed");
    });
    const client = new TrackerClient({
      workerFactory: () => worker,
      mainThreadFactory,
      onResult: vi.fn(),
      onUnavailable
    });

    const start = client.start();
    worker.emit({ type: "unavailable", message: "Worker OpenCV failed" });

    await expect(start).rejects.toThrow("Main-thread OpenCV failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mainThreadFactory).toHaveBeenCalledOnce();
    expect(client.status).toBe("unavailable");
    expect(onUnavailable).toHaveBeenCalledWith("Main-thread OpenCV failed");
  });
});

class FakeWorker implements TrackingWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posts: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  terminate = vi.fn();

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posts.push({ message, transfer });
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function fakeBitmap() {
  const close = vi.fn();
  return { bitmap: { close } as unknown as ImageBitmap, close };
}

function trackedResult(timestampMs: number): TrackerResult {
  return {
    status: "tracked",
    timestampMs,
    keyframeId: 1,
    visualHomography: SENSOR_IDENTITY,
    quality: {
      state: "locked",
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    }
  };
}
