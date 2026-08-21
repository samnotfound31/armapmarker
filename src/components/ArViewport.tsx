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
  type DisplayRotation
} from "../geometry/displayTransform";

export type ArViewportProps = {
  stream: MediaStream;
  route: readonly RouteGroundPoint[];
  calibration: GroundCalibration;
  pose: PoseEstimate;
  backendFactory?: RouteRenderBackendFactory;
};

export function ArViewport({
  stream,
  route,
  calibration,
  pose,
  backendFactory
}: ArViewportProps) {
  const hostRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef(pose);
  const [compatibilityError, setCompatibilityError] = useState<string | null>(null);

  useEffect(() => {
    poseRef.current = pose;
  }, [pose]);

  useEffect(() => {
    const host = hostRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!host || !video || !canvas) return;

    video.srcObject = stream;
    let renderer: RouteRenderer;
    try {
      renderer = new RouteRenderer({
        canvas,
        route,
        calibration,
        ...(backendFactory ? { backendFactory } : {})
      });
    } catch (error) {
      setCompatibilityError(errorMessage(error));
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
      const rotationDeg = inferDisplayRotation(
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

    const onLoadedMetadata = () => resize(lastWidth, lastHeight);
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
    document.addEventListener("visibilitychange", onVisibilityChange);
    startFrames();

    return () => {
      stopFrames();
      document.removeEventListener("visibilitychange", onVisibilityChange);
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

function inferDisplayRotation(
  imageWidthPx: number,
  imageHeightPx: number,
  screenWidthPx: number,
  screenHeightPx: number
): DisplayRotation {
  const imageIsPortrait = imageHeightPx > imageWidthPx;
  const screenIsPortrait = screenHeightPx > screenWidthPx;
  return imageIsPortrait === screenIsPortrait ? 0 : 90;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "This browser could not create the AR overlay.";
}
