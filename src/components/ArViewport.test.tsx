import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroundCalibration, PoseEstimate, RouteGroundPoint } from "../domain/types";
import { FakeRenderer } from "../test/fakes/FakeRenderer";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { ArViewport } from "./ArViewport";

let resizeCallback: ResizeObserverCallback | null = null;
let frameCallback: FrameRequestCallback | null = null;

describe("ArViewport", () => {
  beforeEach(() => {
    resizeCallback = null;
    frameCallback = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 7;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("layers video and canvas, resizes, pauses while hidden, and disposes", () => {
    const backend = new FakeRenderer();
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { container, unmount } = render(
      <ArViewport
        stream={stream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => backend}
      />
    );
    const video = container.querySelector("video")!;
    expect(video).toHaveAttribute("playsinline");
    expect(container.querySelector("canvas")).toBeInTheDocument();

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 390, height: 844 } } as ResizeObserverEntry],
        {} as ResizeObserver
      );
      frameCallback?.(16);
    });
    expect(backend.resizeCalls[0]).toMatchObject({ widthPx: 390, heightPx: 844 });
    expect(backend.renderCount).toBe(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(cancelAnimationFrame).toHaveBeenCalled();

    unmount();
    expect(backend.disposeCount).toBe(1);
    expect(video.srcObject).toBeNull();
  });

  it("shows a compatibility message when WebGL creation fails", () => {
    const onFailure = vi.fn();
    render(
      <ArViewport
        stream={{ getTracks: () => [] } as unknown as MediaStream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => {
          throw new Error("WebGL context unavailable");
        }}
        onFailure={onFailure}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/webgl.*unavailable/i);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({
      kind: "renderer",
      message: "WebGL context unavailable"
    });
  });

  it("reports WebGL context loss once even when the browser repeats the event", () => {
    const onFailure = vi.fn();
    const { container } = render(
      <ArViewport
        stream={{ getTracks: () => [] } as unknown as MediaStream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => new FakeRenderer()}
        onFailure={onFailure}
      />
    );
    const canvas = container.querySelector("canvas")!;
    const firstLoss = new Event("webglcontextlost", { cancelable: true });

    act(() => {
      canvas.dispatchEvent(firstLoss);
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });

    expect(firstLoss.defaultPrevented).toBe(true);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({
      kind: "context-lost",
      message: "The WebGL context was lost."
    });
  });

  it("ignores initial zero metadata and accepts delivered dimensions matching calibration", () => {
    const onFailure = vi.fn();
    const { container } = render(
      <ArViewport
        stream={{ getTracks: () => [] } as unknown as MediaStream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => new FakeRenderer()}
        onFailure={onFailure}
      />
    );
    const video = container.querySelector("video")!;

    setVideoDimensions(video, 0, 0);
    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    setVideoDimensions(video, 1280, 720);
    act(() => video.dispatchEvent(new Event("loadedmetadata")));

    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a meaningful delivered-video mismatch once", () => {
    const onFailure = vi.fn();
    const { container } = render(
      <ArViewport
        stream={{ getTracks: () => [] } as unknown as MediaStream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => new FakeRenderer()}
        onFailure={onFailure}
      />
    );
    const video = container.querySelector("video")!;

    setVideoDimensions(video, 1920, 1080);
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({
      kind: "video-dimensions",
      message: expect.stringMatching(/resolution changed.*re-align/i),
      imageWidthPx: 1920,
      imageHeightPx: 1080
    });
  });

  it("keeps matching camera intrinsics valid when only the screen rotates", () => {
    const onFailure = vi.fn();
    const { container } = render(
      <ArViewport
        stream={{ getTracks: () => [] } as unknown as MediaStream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => new FakeRenderer()}
        onFailure={onFailure}
      />
    );
    const video = container.querySelector("video")!;
    setVideoDimensions(video, 1280, 720);

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
      resizeCallback?.(
        [{ contentRect: { width: 844, height: 390 } } as ResizeObserverEntry],
        {} as ResizeObserver
      );
    });

    expect(onFailure).not.toHaveBeenCalled();
  });
});

function setVideoDimensions(
  video: HTMLVideoElement,
  widthPx: number,
  heightPx: number
): void {
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: widthPx },
    videoHeight: { configurable: true, value: heightPx }
  });
}

function route(): RouteGroundPoint[] {
  return [
    { rightMeters: 0, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 0 },
    { rightMeters: 0, upMeters: 0, forwardMeters: 50, routeDistanceMeters: 50 }
  ];
}

function calibration(): GroundCalibration {
  return {
    stage: "locked",
    cameraHeightMeters: 1.4,
    intrinsics: buildApproximateIntrinsics(1280, 720),
    imageToScreen: IDENTITY_MAT3,
    groundFromRoute: IDENTITY_MAT4,
    cameraFromGroundAtLock: IDENTITY_MAT4,
    calibrationRouteDistanceMeters: 0,
    lockedAtMs: 1
  };
}

function pose(): PoseEstimate {
  return {
    cameraPositionGroundMeters: [0, 1.4, 0],
    orientationQuaternion: [0, 0, 0, 1],
    cameraFromGround: IDENTITY_MAT4,
    visualCorrection: { imageHomography: IDENTITY_MAT3, keyframeId: 1, timestampMs: 1 },
    routeProgressMeters: 0,
    quality: {
      state: "locked",
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    },
    timestampMs: 1
  };
}
