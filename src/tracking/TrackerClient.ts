import type { Mat3 } from "../domain/types";
import { DEFAULT_TRACKING_THRESHOLDS } from "./quality";
import type {
  TrackerResult,
  TrackingFrameContext,
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
    sensorHomography: Mat3,
    context?: TrackingFrameContext
  ): Promise<TrackerResult>;
  commit?(timestampMs: number, accepted: boolean, promote?: boolean): boolean;
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
  onResult: (result: TrackerResult) => boolean | void;
  onUnavailable?: (message: string) => void;
  onDiscarded?:()=>void;
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
  private fallbackAttempted = false;
  private deadline:ReturnType<typeof setTimeout>|null=null;

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
      const tracker=await this.options.mainThreadFactory();
      if(this.currentStatus!=="starting"){tracker.dispose();throw new Error("Tracker client was disposed during initialization.");}
      this.mainThreadTracker=tracker;
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
    sensorHomography: Mat3,
    context?: TrackingFrameContext
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
    this.armDeadline(1000,()=>this.handleWorkerUnavailable("Visual processing timeout; reacquiring."));
    this.lastSubmittedTimestampMs = timestampMs;
    if (this.worker) {
      this.worker.postMessage(
        { type: "frame", frame, timestampMs, sensorHomography, context },
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
    const started=this.now();
    void tracker
      .process(frame, timestampMs, sensorHomography, context)
      .then((result) => this.deliverIfFresh({...result,processingMs:this.now()-started}))
      .catch((error: unknown) => {
        this.markUnavailable(errorMessage(error, "Visual tracking stopped."));
      })
      .finally(() => {
        this.inFlight = false;
        this.clearDeadline();
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
    this.clearDeadline();
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
          this.handleWorkerUnavailable(message);
        };
        worker.postMessage({ type: "initialize" });
        this.armDeadline(15000,()=>this.failWorkerInitialization("Visual worker initialization timeout."));
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
      this.clearDeadline();
      this.resolveStart?.();
      this.clearStartCallbacks();
      return;
    }
    if (message.type === "unavailable") {
      this.handleWorkerUnavailable(message.message);
      return;
    }

    this.inFlight = false;
    this.clearDeadline();
    this.deliverIfFresh(message.result);
  }

  private deliverIfFresh(result: TrackerResult): void {
    const ageMs = this.now() - result.timestampMs;
    const fresh=this.currentStatus==="ready" && ageMs>=0 && ageMs<=this.maxResultAgeMs;
    if(this.currentStatus==="ready"&&!fresh)this.options.onDiscarded?.();
    const accepted=fresh && this.options.onResult(result)!==false;
    const promote=accepted && Boolean(result.promoteCandidate);
    this.worker?.postMessage({type:"commit",timestampMs:result.timestampMs,accepted,promote});
    this.mainThreadTracker?.commit?.(result.timestampMs,accepted,promote);
  }

  private failWorkerInitialization(message: string): void {
    if (this.currentStatus !== "starting" || this.fallbackAttempted) return;
    this.fallbackAttempted = true;
    this.clearDeadline();
    this.terminateFailedWorker();
    void this.startMainThreadFallback(message);
  }

  private handleWorkerUnavailable(message: string): void {
    if (this.currentStatus === "starting") {
      this.failWorkerInitialization(message);
      return;
    }
    if (this.currentStatus === "ready") {
      this.terminateFailedWorker();
      this.markUnavailable(message);
    }
  }

  private async startMainThreadFallback(workerMessage: string): Promise<void> {
    try {
      const tracker = await this.options.mainThreadFactory();
      if (this.currentStatus !== "starting") {
        tracker.dispose();
        return;
      }
      this.mainThreadTracker = tracker;
      this.currentStatus = "ready";
      this.clearDeadline();
      this.resolveStart?.();
      this.clearStartCallbacks();
    } catch (error) {
      if (this.currentStatus !== "starting") return;
      const message = errorMessage(
        error,
        `${workerMessage}; main-thread OpenCV could not initialize.`
      );
      const reject = this.rejectStart;
      this.clearStartCallbacks();
      this.markUnavailable(message);
      reject?.(new Error(message, { cause: error }));
    }
  }

  private terminateFailedWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private markUnavailable(message: string): void {
    if (this.currentStatus === "disposed") return;
    this.currentStatus = "unavailable";
    this.clearDeadline();
    this.inFlight = false;
    this.options.onUnavailable?.(message);
  }

  private clearDeadline(){if(this.deadline)clearTimeout(this.deadline);this.deadline=null;}
  private armDeadline(ms:number,callback:()=>void){this.clearDeadline();this.deadline=setTimeout(callback,ms);}
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
