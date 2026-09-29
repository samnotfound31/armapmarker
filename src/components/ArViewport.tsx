import { useEffect, useRef, useState } from "react";
import type {
  GroundCalibration,
  PoseEstimate,
  RouteGroundPoint
} from "../domain/types";
import {
  RouteRenderer,
  type RouteRenderDiagnostics,
  type RouteRenderBackendFactory
} from "../ar/RouteRenderer";
import {
  createDisplayTransform,
  readScreenOrientationAngle,
  resolveDisplayRotation
} from "../geometry/displayTransform";
import type { NavigationSnapshot } from "../navigation/navigationEngine";
import type { NavigationRuntimeSnapshot } from "../session/NavigationSession";

export type ArViewportProps = {
  stream: MediaStream;
  route: readonly RouteGroundPoint[];
  calibration: GroundCalibration;
  pose: PoseEstimate;
  backendFactory?: RouteRenderBackendFactory;
  onFailure?: (failure: ArViewportFailure) => void;
  navigation?: NavigationSnapshot;
  geographic?: NavigationRuntimeSnapshot["geographic"];
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
  onFailure,
  navigation,
  geographic
}: ArViewportProps) {
  const hostRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef(pose);
  const failureCallbackRef = useRef(onFailure);
  const [diagnostics, setDiagnostics] = useState<RouteRenderDiagnostics>();
  const debugEnabled = new URLSearchParams(window.location.search).get("arDebug") === "1";
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

    let lastDiagnosticsMs = 0;
    const renderFrame = (nowMs: number) => {
      const next = renderer.render(poseRef.current);
      if (nowMs - lastDiagnosticsMs >= 250) {
        lastDiagnosticsMs = nowMs;
        setDiagnostics(next);
      }
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
      {debugEnabled && diagnostics && <output className="ar-debug" aria-label="AR diagnostics">
        <div>Geographic state: {pose.geographicState ?? "HEADING_UNCERTAIN"}</div>
        <div>GPS: {geographic?.locationStatus ?? "REJECTED"} · Accuracy: {geographic?.locationAccuracyMeters?.toFixed(1) ?? "—"} m · Age: {geographic?.locationAgeMs !== null && geographic?.locationAgeMs !== undefined ? (geographic.locationAgeMs/1000).toFixed(1) : "—"} s</div>
        <div>Location: {geographic?.locationReason ?? "awaiting-location"}</div>
        <div>Heading: {geographic?.heading?.usable ? "available" : "uncertain"} · {geographic?.heading?.headingRad !== null && geographic?.heading?.headingRad !== undefined ? (geographic.heading.headingRad*180/Math.PI).toFixed(0) : "—"}° · Accuracy: {geographic?.heading?.accuracyDeg?.toFixed(0) ?? "—"}°</div>
        <div>Route segment: {navigation?.matchedSegmentIndex ?? "—"} · Progress: {pose.routeProgressMeters.toFixed(1)} m</div>
        <div>Cross-track: {navigation?.crossTrackDistanceMeters?.toFixed(1) ?? "—"} m · Bearing: {navigation?.routeBearingRad !== undefined ? ((navigation.routeBearingRad*180/Math.PI+360)%360).toFixed(0) : "—"}°</div>
        <div>Movement agreement: {navigation?.movementAgreement?.toFixed(2) ?? "—"}</div>
        <div>State: {pose.quality.state === "weak" ?
          pose.quality.visualUpdate === "valid" ? "RECOVERING" : pose.quality.visualUpdate === "rejected" ? "WEAK" : "APPROXIMATE" : pose.quality.state.toUpperCase()}</div>
        <div>Visual features: {pose.quality.featureCount} · Inliers: {pose.quality.inlierCount}</div>
        <div>Route points ahead: {diagnostics.routePointsAhead} · Transformed: {diagnostics.transformed}</div>
        <div>In front: {diagnostics.inFrontOfCamera} · Projected: {diagnostics.projected}</div>
        <div>Visible markers: {diagnostics.visibleMarkers} · Rendered: {diagnostics.renderedMarkers}</div>
        <div>Last visual update: {pose.quality.visualUpdate ?? "initializing"}</div>
        <div>Confidence: {(pose.quality.confidence ?? 0.3).toFixed(2)}</div>
        <div>Reason: {pose.quality.rejectionReason ?? diagnostics.reason}</div>
      </output>}
      {diagnostics?.renderedMarkers === 0 && pose.quality.state !== "realign" && pose.geographicState === "VALID" &&
        <p className="projection-hint">{diagnostics.reason === "no-route-ahead" ? "End of route ahead" : "Point toward the path with ground in view"}</p>}
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
