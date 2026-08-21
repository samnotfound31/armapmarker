import type { Mat3 } from "../domain/types";
import { DEFAULT_TRACKING_THRESHOLDS } from "./quality";
import type {
  TrackerResult,
  TrackerWorkerRequest,
  TrackerWorkerResponse
} from "./types";

export type TrackerClientStatus =
  | "idle"
  | "starting"
  | "ready"
  | "unavailable"
  | "disposed";

export type MainThreadTracker = {
  process(
    frame: ImageBitmap,
    timestampMs: number,
    sensorHomography: Mat3
  ): Promise<TrackerResult>;
  dispose(): void;
};

export type TrackingWorkerLike = {
  onmessage: ((event: MessageEvent<TrackerWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TrackerWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
};

export type TrackerClientOptions = {
  workerFactory?: (() => TrackingWorkerLike) | null;
  mainThreadFactory: () => Promise<MainThreadTracker>;
  onResult: (result: TrackerResult) => void;
  onUnavailable?: (message: string) => void;
  now?: () => number;
  mainThreadIntervalMs?: number;
  maxResultAgeMs?: number;
};

export class TrackerClient {
  private readonly workerFactory: (() => TrackingWorkerLike) | null;
  private readonly now: () => number;
  private readonly mainThreadIntervalMs: number;
  private readonly maxResultAgeMs: number;
  private worker: TrackingWorkerLike | null = null;
  private mainThreadTracker: MainThreadTracker | null = null;
  private inFlight = false;
  private lastSubmittedTimestampMs = Number.NEGATIVE_INFINITY;
  private currentStatus: TrackerClientStatus = "idle";
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;

  constructor(private readonly options: TrackerClientOptions) {
    this.workerFactory =
      options.workerFactory === undefined ? defaultWorkerFactory() : options.workerFactory;
    this.now = options.now ?? (() => performance.now());
    this.mainThreadIntervalMs = options.mainThreadIntervalMs ?? 100;
    this.maxResultAgeMs =
      options.maxResultAgeMs ?? DEFAULT_TRACKING_THRESHOLDS.maxResultAgeMs;
  }

  get status(): TrackerClientStatus {
    return this.currentStatus;
  }

  async start(): Promise<void> {
    if (this.currentStatus !== "idle") {
      throw new Error(`Tracker client cannot start from ${this.currentStatus}.`);
    }
    this.currentStatus = "starting";

    if (this.workerFactory) {
      await this.startWorker();
      return;
    }

    try {
      this.mainThreadTracker = await this.options.mainThreadFactory();
      this.currentStatus = "ready";
    } catch (error) {
      const message = errorMessage(error, "OpenCV could not initialize.");
      this.markUnavailable(message);
      throw new Error(message, { cause: error });
    }
  }

  submitFrame(
    frame: ImageBitmap,
    timestampMs: number,
    sensorHomography: Mat3
  ): boolean {
    if (this.currentStatus !== "ready" || this.inFlight) {
      frame.close();
      return false;
    }

    if (
      this.mainThreadTracker &&
      timestampMs - this.lastSubmittedTimestampMs < this.mainThreadIntervalMs
    ) {
      frame.close();
      return false;
    }

    this.inFlight = true;
    this.lastSubmittedTimestampMs = timestampMs;
    if (this.worker) {
      this.worker.postMessage(
        { type: "frame", frame, timestampMs, sensorHomography },
        [frame]
      );
      return true;
    }

    const tracker = this.mainThreadTracker;
    if (!tracker) {
      this.inFlight = false;
      frame.close();
      return false;
    }
    void tracker
      .process(frame, timestampMs, sensorHomography)
      .then((result) => this.deliverIfFresh(result))
      .catch((error: unknown) => {
        this.markUnavailable(errorMessage(error, "Visual tracking stopped."));
      })
      .finally(() => {
        this.inFlight = false;
        frame.close();
      });
    return true;
  }

  dispose(): void {
    if (this.currentStatus === "disposed") return;
    const disposalError = new Error("Tracker client was disposed during initialization.");
    this.rejectStart?.(disposalError);
    this.clearStartCallbacks();
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker = null;
    }
    this.mainThreadTracker?.dispose();
    this.mainThreadTracker = null;
    this.inFlight = false;
    this.currentStatus = "disposed";
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      try {
        const worker = this.workerFactory!();
        this.worker = worker;
        worker.onmessage = (event) => this.handleWorkerMessage(event.data);
        worker.onerror = (event) => {
          const message = event.message || "Visual tracking worker failed.";
          this.failWorkerInitialization(message);
        };
        worker.postMessage({ type: "initialize" });
      } catch (error) {
        this.failWorkerInitialization(
          errorMessage(error, "Visual tracking worker could not start.")
        );
      }
    });
  }

  private handleWorkerMessage(message: TrackerWorkerResponse): void {
    if (message.type === "ready") {
      if (this.currentStatus !== "starting") return;
      this.currentStatus = "ready";
      this.resolveStart?.();
      this.clearStartCallbacks();
      return;
    }
    if (message.type === "unavailable") {
      this.failWorkerInitialization(message.message);
      return;
    }

    this.inFlight = false;
    this.deliverIfFresh(message.result);
  }

  private deliverIfFresh(result: TrackerResult): void {
    const ageMs = this.now() - result.timestampMs;
    if (ageMs < 0 || ageMs > this.maxResultAgeMs) return;
    this.options.onResult(result);
  }

  private failWorkerInitialization(message: string): void {
    const error = new Error(message);
    const reject = this.rejectStart;
    this.clearStartCallbacks();
    this.markUnavailable(message);
    reject?.(error);
  }

  private markUnavailable(message: string): void {
    if (this.currentStatus === "disposed") return;
    this.currentStatus = "unavailable";
    this.inFlight = false;
    this.options.onUnavailable?.(message);
  }

  private clearStartCallbacks(): void {
    this.resolveStart = null;
    this.rejectStart = null;
  }
}

function defaultWorkerFactory(): (() => TrackingWorkerLike) | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  return () =>
    new Worker(new URL("./tracker.worker.ts", import.meta.url), {
      type: "module"
    }) as unknown as TrackingWorkerLike;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
