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
    render(
      <ArViewport
        stream={{ getTracks: () => [] } as unknown as MediaStream}
        route={route()}
        calibration={calibration()}
        pose={pose()}
        backendFactory={() => {
          throw new Error("WebGL context unavailable");
        }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/webgl.*unavailable/i);
  });
});

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
