/// <reference lib="webworker" />

import { loadOpenCvTracker, type OpenCvTracker } from "./OpenCvTracker";
import type { TrackerWorkerRequest, TrackerWorkerResponse } from "./types";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let tracker: OpenCvTracker | null = null;
let initializing: Promise<OpenCvTracker> | null = null;

workerScope.onmessage = (event: MessageEvent<TrackerWorkerRequest>) => {
  void handleMessage(event.data);
};

async function handleMessage(message: TrackerWorkerRequest): Promise<void> {
  if (message.type === "initialize") {
    try {
      initializing ??= loadOpenCvTracker();
      tracker = await initializing;
      post({ type: "ready" });
    } catch (error) {
      post({ type: "unavailable", message: errorMessage(error) });
    }
    return;
  }

  if (message.type === "dispose") {
    tracker?.dispose();
    tracker = null;
    workerScope.close();
    return;
  }

  try {
    if (!tracker) throw new Error("OpenCV tracker is not ready.");
    const result = await tracker.process(
      message.frame,
      message.timestampMs,
      message.sensorHomography
    );
    post({ type: "result", result });
  } catch (error) {
    tracker?.dispose();
    tracker = null;
    post({ type: "unavailable", message: errorMessage(error) });
  } finally {
    message.frame.close();
  }
}

function post(message: TrackerWorkerResponse): void {
  workerScope.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "OpenCV visual tracking is unavailable.";
}
