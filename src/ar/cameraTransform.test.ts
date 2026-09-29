import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { RouteRenderer } from "./RouteRenderer";
import { buildCameraFromGroundAtLock } from "../geometry/groundCalibration";
import { buildApproximateIntrinsics } from "../geometry/intrinsics";
import { PoseFusion } from "../pose/PoseFusion";
import { IDENTITY_MAT3, IDENTITY_MAT4 } from "../test/geometryFixtures";
import type { GroundCalibration } from "../domain/types";

const rendered = vi.hoisted(() => ({ depths: [] as number[] }));
vi.mock("three", async (original) => {
  const actual = await original<typeof THREE>();
  return { ...actual, WebGLRenderer: class {
    setClearColor() {} setPixelRatio() {} setSize() {} dispose() {}
    render(scene: THREE.Scene, camera: THREE.Camera) {
      // Match Three's actual render-time camera update, using its real Camera.
      if (camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      const mesh = scene.children[0] as THREE.Mesh;
      const positions = mesh.geometry.getAttribute("position");
      for (let i = 0; i < positions.count; i++) {
        rendered.depths.push(new actual.Vector3().fromBufferAttribute(positions, i)
          .applyMatrix4(camera.matrixWorldInverse).z);
      }
    }
  } };
});

it("keeps the supplied camera transform through Three's render so ground markers stay in front", () => {
  rendered.depths = [];
  const calibration: GroundCalibration = {
    stage: "locked", cameraHeightMeters: 1.4,
    intrinsics: buildApproximateIntrinsics(720, 1280), imageToScreen: IDENTITY_MAT3,
    groundFromRoute: IDENTITY_MAT4,
    cameraFromGroundAtLock: buildCameraFromGroundAtLock({ alphaRad: 0, betaRad: 1.2, gammaRad: 0 }, 1.4),
    calibrationRouteDistanceMeters: 0
  };
  const renderer = new RouteRenderer({canvas: document.createElement("canvas"), calibration,
    route: [{ rightMeters: 0, upMeters: 0, forwardMeters: 0, routeDistanceMeters: 0 },
      { rightMeters: 0, upMeters: 0, forwardMeters: 30, routeDistanceMeters: 30 }] });
  renderer.render(new PoseFusion(calibration).snapshot(0));
  expect(rendered.depths.length).toBeGreaterThan(0);
  expect(rendered.depths.every((z) => z < 0)).toBe(true);
  renderer.dispose();
});
