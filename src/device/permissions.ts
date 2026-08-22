import { startRearCamera, stopMediaStream } from "./camera";
import {
  LocationAccessError,
  requestCurrentLocation,
  type LocationFix
} from "./location";

export type ArPermissionCode =
  | "insecure-context"
  | "camera-denied"
  | "camera-unavailable"
  | "motion-denied"
  | "motion-unavailable"
  | "location-denied"
  | "location-inaccurate"
  | "location-unavailable";

export class ArPermissionError extends Error {
  public readonly name = "ArPermissionError";

  public constructor(
    public readonly code: ArPermissionCode,
    message: string
  ) {
    super(message);
  }
}

type PermissionResult = "granted" | "denied";
type PermissionEventConstructor = {
  requestPermission?: () => Promise<PermissionResult>;
};

export type MotionPermissionEnvironment = {
  isSecureContext: boolean;
  DeviceOrientationEvent?: PermissionEventConstructor;
  DeviceMotionEvent?: PermissionEventConstructor;
};

export type MotionPermissionMode = "prompted" | "not-required";

export type ArAccessGrant = {
  stream: MediaStream;
  location: LocationFix;
};

type ArAccessDependencies = {
  startCamera: (video: HTMLVideoElement) => Promise<MediaStream>;
  requestMotion: () => Promise<MotionPermissionMode>;
  requestLocation: (signal: AbortSignal) => Promise<LocationFix>;
};

export type VisibilitySource = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener: (
    type: "visibilitychange",
    listener: EventListener
  ) => void;
  removeEventListener: (
    type: "visibilitychange",
    listener: EventListener
  ) => void;
};

export function requestMotionPermission(
  environment: MotionPermissionEnvironment = readMotionEnvironment()
): Promise<MotionPermissionMode> {
  if (!environment.isSecureContext) {
    return Promise.reject(
      new ArPermissionError(
        "insecure-context",
        "Camera and motion sensors require HTTPS."
      )
    );
  }
  if (!environment.DeviceOrientationEvent && !environment.DeviceMotionEvent) {
    return Promise.reject(
      new ArPermissionError(
        "motion-unavailable",
        "This browser does not provide motion and orientation sensors."
      )
    );
  }

  const prompts = [
    environment.DeviceOrientationEvent?.requestPermission?.(),
    environment.DeviceMotionEvent?.requestPermission?.()
  ].filter((prompt): prompt is Promise<PermissionResult> => prompt !== undefined);

  if (prompts.length === 0) {
    return Promise.resolve("not-required");
  }

  return Promise.all(prompts).then((results) => {
    if (results.some((result) => result !== "granted")) {
      throw new ArPermissionError(
        "motion-denied",
        "Motion and orientation permission was denied."
      );
    }
    return "prompted";
  });
}

export async function requestArAccess(
  video: HTMLVideoElement,
  signal: AbortSignal,
  overrides: Partial<ArAccessDependencies> = {}
): Promise<ArAccessGrant> {
  const dependencies: ArAccessDependencies = {
    startCamera: (target) => startRearCamera(target),
    requestMotion: () => requestMotionPermission(),
    requestLocation: (requestSignal) =>
      requestCurrentLocation(requestSignal),
    ...overrides
  };
  let cameraRequest: Promise<MediaStream>;
  let motionRequest: Promise<
    | { granted: true; mode: MotionPermissionMode }
    | { granted: false; error: unknown }
  >;
  try {
    cameraRequest = dependencies.startCamera(video);
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw createAbortError();
    throw mapCameraError(error);
  }
  try {
    motionRequest = dependencies.requestMotion().then(
      (mode) => ({ granted: true as const, mode }),
      (error: unknown) => ({ granted: false as const, error })
    );
  } catch (error) {
    motionRequest = Promise.resolve({ granted: false as const, error });
  }

  let stream: MediaStream;
  try {
    stream = await cameraRequest;
  } catch (error) {
    void motionRequest;
    if (isAbortError(error) || signal.aborted) throw createAbortError();
    throw mapCameraError(error);
  }

  try {
    if (signal.aborted) throw createAbortError();
    const motion = await motionRequest;
    if (!motion.granted) throw motion.error;
    if (signal.aborted) throw createAbortError();
    const location = await dependencies.requestLocation(signal);
    if (signal.aborted) throw createAbortError();
    return { stream, location };
  } catch (error) {
    stopMediaStream(stream);
    if (error instanceof ArPermissionError || isAbortError(error)) throw error;
    if (error instanceof LocationAccessError) throw mapLocationError(error);
    throw new ArPermissionError(
      "location-unavailable",
      "Location could not be confirmed for AR."
    );
  }
}

export function watchVisibility(
  source: VisibilitySource,
  callbacks: { onPause: () => void; onResume: () => void }
): () => void {
  const onVisibilityChange: EventListener = () => {
    if (source.visibilityState === "hidden") callbacks.onPause();
    else callbacks.onResume();
  };
  source.addEventListener("visibilitychange", onVisibilityChange);
  return () =>
    source.removeEventListener("visibilitychange", onVisibilityChange);
}

function readMotionEnvironment(): MotionPermissionEnvironment {
  return {
    isSecureContext: globalThis.isSecureContext,
    DeviceOrientationEvent: globalThis.DeviceOrientationEvent as unknown as
      | PermissionEventConstructor
      | undefined,
    DeviceMotionEvent: globalThis.DeviceMotionEvent as unknown as
      | PermissionEventConstructor
      | undefined
  };
}

function mapCameraError(error: unknown): ArPermissionError {
  const denied = error instanceof DOMException && error.name === "NotAllowedError";
  return denied
    ? new ArPermissionError("camera-denied", "Camera permission was denied.")
    : new ArPermissionError(
        "camera-unavailable",
        "The rear camera could not be started."
      );
}

function mapLocationError(error: LocationAccessError): ArPermissionError {
  if (error.code === "denied") {
    return new ArPermissionError("location-denied", error.message);
  }
  if (error.code === "inaccurate") {
    return new ArPermissionError("location-inaccurate", error.message);
  }
  return new ArPermissionError("location-unavailable", error.message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function createAbortError(): DOMException {
  return new DOMException("AR permission request cancelled.", "AbortError");
}
