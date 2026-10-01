import { describe, expect, it } from "vitest";
import type { GroundCalibration, PoseEstimate, RouteGroundPoint } from "../domain/types";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { FakeRenderer } from "../test/fakes/FakeRenderer";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import { RouteRenderer } from "./RouteRenderer";

describe("RouteRenderer", () => {
  it.each(["OFF_ROUTE", "WRONG_WAY", "HEADING_UNCERTAIN", "LOCATION_UNCERTAIN", "ROUTE_MATCH_UNCERTAIN", "DEVIATED"] as const)(
    "suppresses visually locked markers when geographic state is %s", (geographicState) => {
      const backend = new FakeRenderer();
      const renderer = createRenderer(backend);
      const wrong = { ...pose(0), geographicState };
      renderer.render(wrong);
      expect(backend.viewCalls.at(-1)!.overlayOpacity).toBe(0);
      renderer.render({ ...wrong, geographicState: "VALID" });
      expect(backend.viewCalls.at(-1)!.overlayOpacity).toBe(1);
    }
  );
  it("reports why a valid HUD route has no projected markers", () => {
    const backend = new FakeRenderer();
    const renderer = createRenderer(backend);
    renderer.resize(390, 844);
    const reversed = pose(0);
    reversed.cameraFromGround = [1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,0,0,1];
    const result = renderer.render(reversed);
    expect(result?.routePointsAhead).toBeGreaterThan(0);
    expect(result?.inFrontOfCamera).toBe(0);
    expect(result?.reason).toBe("behind-camera");
  });

  it("keeps geometry populated and opacity positive through a weak update", () => {
    const backend = new FakeRenderer();
    const renderer = createRenderer(backend);
    renderer.render(pose(0));
    renderer.render(pose(0, "weak"));
    expect(backend.geometryCalls).toHaveLength(1);
    expect(backend.geometryCalls[0]!.markerCount).toBeGreaterThan(0);
    expect(backend.viewCalls.at(-1)!.overlayOpacity).toBeGreaterThan(0);
  });

  it("rebuilds geometry only after progress crosses the sampling threshold", () => {
    const backend = new FakeRenderer();
    const renderer = createRenderer(backend);

    renderer.render(pose(0));
    renderer.render(pose(0.5));
    renderer.render(pose(1));

    expect(backend.geometryCalls).toHaveLength(2);
    expect(backend.viewCalls).toHaveLength(3);
    expect(backend.renderCount).toBe(3);
  });

  it("caps device pixel ratio at two and disposes the backend", () => {
    const backend = new FakeRenderer();
    const renderer = createRenderer(backend);

    renderer.resize(390, 844, 3);
    renderer.dispose();
    renderer.dispose();

    expect(backend.resizeCalls).toEqual([
      { widthPx: 390, heightPx: 844, pixelRatio: 2 }
    ]);
    expect(backend.disposeCount).toBe(1);
  });

  it("fades weak geometry, hides realign geometry, and restores locked opacity", () => {
    const backend = new FakeRenderer();
    const renderer = createRenderer(backend);

    renderer.render(pose(0, "locked"));
    renderer.render(pose(0, "weak"));
    renderer.render(pose(0, "realign"));
    renderer.render(pose(0, "locked"));

    expect(backend.viewCalls.map((view) => view.overlayOpacity)).toEqual([
      1,
      0.5,
      0,
      1
    ]);
  });
});

function createRenderer(backend: FakeRenderer): RouteRenderer {
  return new RouteRenderer({
    canvas: document.createElement("canvas"),
    route: route(),
    calibration: calibration(),
    backendFactory: () => backend,
    geometryProgressThresholdMeters: 0.75
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

function pose(
  routeProgressMeters: number,
  qualityState: PoseEstimate["quality"]["state"] = "locked"
): PoseEstimate {
  return {
    cameraPositionGroundMeters: [0, 1.4, routeProgressMeters],
    orientationQuaternion: [0, 0, 0, 1],
    cameraFromGround: IDENTITY_MAT4,
    visualCorrection: { imageHomography: IDENTITY_MAT3, keyframeId: 1, timestampMs: 1 },
    routeProgressMeters,
    overlayOpacity:qualityState === "locked" ? 1 : qualityState === "realign" ? 0 : 0.5,
    quality: {
      state: qualityState,
      featureCount: 40,
      inlierCount: 30,
      inlierRatio: 0.75,
      medianReprojectionErrorPx: 1
    },
    timestampMs: 1
    , geographicState: "VALID"
  };
}
