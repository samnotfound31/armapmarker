import { useEffect, useRef, useState } from "react";
import type {
  GroundCalibration,
  PoseEstimate,
  RouteGroundPoint
} from "../domain/types";
import {
  RouteRenderer,
  type RouteRenderBackendFactory
} from "../ar/RouteRenderer";
import {
  createDisplayTransform,
  readScreenOrientationAngle,
  resolveDisplayRotation
} from "../geometry/displayTransform";

export type ArViewportProps = {
  stream: MediaStream;
  route: readonly RouteGroundPoint[];
  calibration: GroundCalibration;
  pose: PoseEstimate;
  backendFactory?: RouteRenderBackendFactory;
  onFailure?: (failure: ArViewportFailure) => void;
};

export type ArViewportFailure =
  | { kind: "renderer"; message: string }
  | { kind: "context-lost"; message: string }
  | {
      kind: "video-dimensions";
      message: string;
      imageWidthPx: number;
      imageHeightPx: number;
    };

export function ArViewport({
  stream,
  route,
  calibration,
  pose,
  backendFactory,
  onFailure
}: ArViewportProps) {
  const hostRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef(pose);
  const failureCallbackRef = useRef(onFailure);
  const [compatibilityError, setCompatibilityError] = useState<string | null>(null);
  failureCallbackRef.current = onFailure;

  useEffect(() => {
    poseRef.current = pose;
  }, [pose]);

  useEffect(() => {
    const host = hostRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!host || !video || !canvas) return;

    video.srcObject = stream;
    let failureReported = false;
    const reportFailure = (failure: ArViewportFailure) => {
      if (failureReported) return;
      failureReported = true;
      setCompatibilityError(failure.message);
      failureCallbackRef.current?.(failure);
    };
    let renderer: RouteRenderer;
    try {
      renderer = new RouteRenderer({
        canvas,
        route,
        calibration,
        ...(backendFactory ? { backendFactory } : {})
      });
    } catch (error) {
      reportFailure({ kind: "renderer", message: errorMessage(error) });
      video.srcObject = null;
      return;
    }

    let frameId: number | null = null;
    let lastWidth = calibration.intrinsics.imageWidthPx;
    let lastHeight = calibration.intrinsics.imageHeightPx;

    const resize = (widthPx: number, heightPx: number) => {
      if (widthPx <= 0 || heightPx <= 0) return;
      lastWidth = widthPx;
      lastHeight = heightPx;
      const imageWidthPx = video.videoWidth || calibration.intrinsics.imageWidthPx;
      const imageHeightPx = video.videoHeight || calibration.intrinsics.imageHeightPx;
      const rotationDeg = resolveDisplayRotation(
        readScreenOrientationAngle(),
        imageWidthPx,
        imageHeightPx,
        widthPx,
        heightPx
      );
      renderer.setDisplayTransform(
        createDisplayTransform({
          imageWidthPx,
          imageHeightPx,
          screenWidthPx: widthPx,
          screenHeightPx: heightPx,
          rotationDeg
        }).imageToScreen
      );
      renderer.resize(widthPx, heightPx, window.devicePixelRatio || 1);
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(host);

    const onLoadedMetadata = () => {
      const imageWidthPx = video.videoWidth;
      const imageHeightPx = video.videoHeight;
      if (
        imageWidthPx > 0 &&
        imageHeightPx > 0 &&
        dimensionsMateriallyDiffer(
          imageWidthPx,
          imageHeightPx,
          calibration.intrinsics.imageWidthPx,
          calibration.intrinsics.imageHeightPx
        )
      ) {
        reportFailure({
          kind: "video-dimensions",
          message:
            `Camera resolution changed from ` +
            `${calibration.intrinsics.imageWidthPx}×${calibration.intrinsics.imageHeightPx} ` +
            `to ${imageWidthPx}×${imageHeightPx}. Re-align the road before AR resumes.`,
          imageWidthPx,
          imageHeightPx
        });
        return;
      }
      resize(lastWidth, lastHeight);
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata);

    const renderFrame = () => {
      renderer.render(poseRef.current);
      frameId = requestAnimationFrame(renderFrame);
    };
    const startFrames = () => {
      if (frameId === null && document.visibilityState !== "hidden") {
        frameId = requestAnimationFrame(renderFrame);
      }
    };
    const stopFrames = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopFrames();
      else startFrames();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      stopFrames();
      reportFailure({
        kind: "context-lost",
        message: "The WebGL context was lost."
      });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    canvas.addEventListener("webglcontextlost", onContextLost);
    startFrames();

    return () => {
      stopFrames();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      resizeObserver.disconnect();
      renderer.dispose();
      video.srcObject = null;
    };
  }, [backendFactory, calibration, route, stream]);

  return (
    <section
      ref={hostRef}
      className="ar-viewport"
      aria-label="Augmented reality navigation view"
    >
      <video
        ref={videoRef}
        className="ar-camera"
        autoPlay
        muted
        playsInline
        aria-label="Rear camera view"
      />
      <canvas ref={canvasRef} className="ar-overlay" aria-hidden="true" />
      {compatibilityError ? (
        <div className="ar-compatibility" role="alert">
          WebGL is unavailable. {compatibilityError}
        </div>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "This browser could not create the AR overlay.";
}

function dimensionsMateriallyDiffer(
  actualWidthPx: number,
  actualHeightPx: number,
  expectedWidthPx: number,
  expectedHeightPx: number
): boolean {
  return (
    Math.abs(actualWidthPx - expectedWidthPx) / expectedWidthPx > 0.01 ||
    Math.abs(actualHeightPx - expectedHeightPx) / expectedHeightPx > 0.01
  );
}
