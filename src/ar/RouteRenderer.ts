import * as THREE from "three";
import type {
  CameraIntrinsics,
  GroundCalibration,
  Mat3,
  Mat4,
  PoseEstimate,
  RouteGroundPoint
} from "../domain/types";
import { multiplyHomographies } from "../tracking/residualHomography";
import { buildRouteRibbon } from "./routeRibbon";

export type RouteGeometryBuffers = {
  positions: Float32Array;
  indices: Uint16Array;
  markerCount: number;
};

export type RouteView = {
  cameraFromRoute: Mat4;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  visualHomography: Mat3;
  screenWidthPx: number;
  screenHeightPx: number;
  overlayOpacity: number;
};

export type RouteRenderBackend = {
  resize(widthPx: number, heightPx: number, pixelRatio: number): void;
  updateGeometry(geometry: RouteGeometryBuffers): void;
  updateView(view: RouteView): void;
  render(): void;
  dispose(): void;
};

export type RouteRenderBackendFactory = (
  canvas: HTMLCanvasElement
) => RouteRenderBackend;

export type RouteRendererOptions = {
  canvas: HTMLCanvasElement;
  route: readonly RouteGroundPoint[];
  calibration: GroundCalibration;
  backendFactory?: RouteRenderBackendFactory;
  geometryProgressThresholdMeters?: number;
};

export class RouteRenderer {
  private readonly backend: RouteRenderBackend;
  private readonly geometryProgressThresholdMeters: number;
  private imageToScreen: Mat3;
  private lastGeometryProgressMeters: number | null = null;
  private screenWidthPx: number;
  private screenHeightPx: number;
  private disposed = false;

  constructor(private readonly options: RouteRendererOptions) {
    this.backend = (options.backendFactory ?? createThreeRenderBackend)(options.canvas);
    this.geometryProgressThresholdMeters =
      options.geometryProgressThresholdMeters ?? 0.75;
    this.imageToScreen = options.calibration.imageToScreen;
    this.screenWidthPx = options.calibration.intrinsics.imageWidthPx;
    this.screenHeightPx = options.calibration.intrinsics.imageHeightPx;
  }

  setDisplayTransform(imageToScreen: Mat3): void {
    this.imageToScreen = imageToScreen;
  }

  resize(widthPx: number, heightPx: number, devicePixelRatio = 1): void {
    if (this.disposed) return;
    if (widthPx <= 0 || heightPx <= 0) return;
    this.screenWidthPx = widthPx;
    this.screenHeightPx = heightPx;
    this.backend.resize(widthPx, heightPx, clamp(devicePixelRatio, 1, 2));
  }

  render(pose: PoseEstimate): void {
    if (this.disposed) return;
    if (
      this.lastGeometryProgressMeters === null ||
      Math.abs(pose.routeProgressMeters - this.lastGeometryProgressMeters) >=
        this.geometryProgressThresholdMeters
    ) {
      const ribbon = buildRouteRibbon(this.options.route, pose.routeProgressMeters);
      this.backend.updateGeometry({
        positions: ribbon.positions,
        indices: ribbon.indices,
        markerCount: ribbon.markers.length
      });
      this.lastGeometryProgressMeters = pose.routeProgressMeters;
    }

    this.backend.updateView({
      cameraFromRoute: multiplyMat4(
        pose.cameraFromGround,
        this.options.calibration.groundFromRoute
      ),
      intrinsics: this.options.calibration.intrinsics,
      imageToScreen: this.imageToScreen,
      visualHomography: pose.visualCorrection.imageHomography,
      screenWidthPx: this.screenWidthPx,
      screenHeightPx: this.screenHeightPx,
      overlayOpacity:
        pose.quality.state === "locked"
          ? 1
          : pose.quality.state === "weak"
            ? 0.5
            : 0
    });
    this.backend.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.backend.dispose();
  }
}

class ThreeRouteRenderBackend implements RouteRenderBackend {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0x2dfb6f,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false
  });
  private readonly edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x07130c,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false
  });
  private readonly mesh = new THREE.Mesh(this.geometry, this.material);
  private readonly edges = new THREE.LineSegments(
    // Route vertices arrive in updateGeometry; EdgesGeometry requires them.
    new THREE.BufferGeometry(),
    this.edgeMaterial
  );
  private edgeGeometry = this.edges.geometry;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance"
    });
    this.renderer.setClearColor(0x000000, 0);
    this.mesh.frustumCulled = false;
    this.edges.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.edges.renderOrder = 2;
    this.scene.add(this.mesh, this.edges);
  }

  resize(widthPx: number, heightPx: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(widthPx, heightPx, false);
  }

  updateGeometry({ positions, indices }: RouteGeometryBuffers): void {
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeBoundingSphere();
    this.edgeGeometry.dispose();
    this.edgeGeometry = new THREE.EdgesGeometry(this.geometry, 20);
    this.edges.geometry = this.edgeGeometry;
  }

  updateView(view: RouteView): void {
    this.mesh.visible = view.overlayOpacity > 0;
    this.edges.visible = view.overlayOpacity > 0;
    this.material.opacity = 0.94 * view.overlayOpacity;
    this.edgeMaterial.opacity = 0.9 * view.overlayOpacity;
    const cvToThree: Mat4 = [
      1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, -1, 0,
      0, 0, 0, 1
    ];
    const cameraView = multiplyMat4(cvToThree, view.cameraFromRoute);
    this.camera.matrixWorldInverse.fromArray([...cameraView]);
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();

    const baseProjection = buildCameraProjection(view.intrinsics, 0.05, 100);
    const displayHomography = multiplyHomographies(
      view.imageToScreen,
      view.visualHomography
    );
    const ndcWarp = buildNdcWarp(
      displayHomography,
      view.intrinsics.imageWidthPx,
      view.intrinsics.imageHeightPx,
      view.screenWidthPx,
      view.screenHeightPx
    );
    this.camera.projectionMatrix
      .fromArray([...ndcWarp])
      .multiply(new THREE.Matrix4().fromArray([...baseProjection]));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.edgeGeometry.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.edgeMaterial.dispose();
    this.renderer.dispose();
  }
}

function createThreeRenderBackend(canvas: HTMLCanvasElement): RouteRenderBackend {
  return new ThreeRouteRenderBackend(canvas);
}

function buildCameraProjection(
  intrinsics: CameraIntrinsics,
  near: number,
  far: number
): Mat4 {
  const { imageWidthPx: width, imageHeightPx: height, fxPx, fyPx, cxPx, cyPx } =
    intrinsics;
  return [
    (2 * fxPx) / width, 0, 0, 0,
    0, (2 * fyPx) / height, 0, 0,
    1 - (2 * cxPx) / width,
    (2 * cyPx) / height - 1,
    -(far + near) / (far - near),
    -1,
    0, 0, (-2 * far * near) / (far - near), 0
  ];
}

function buildNdcWarp(
  imageToScreen: Mat3,
  imageWidthPx: number,
  imageHeightPx: number,
  screenWidthPx: number,
  screenHeightPx: number
): Mat4 {
  const imagePixelFromNdc: Mat3 = [
    imageWidthPx / 2, 0, 0,
    0, -imageHeightPx / 2, 0,
    imageWidthPx / 2, imageHeightPx / 2, 1
  ];
  const screenNdcFromPixel: Mat3 = [
    2 / screenWidthPx, 0, 0,
    0, -2 / screenHeightPx, 0,
    -1, 1, 1
  ];
  const warp = multiplyHomographies(
    screenNdcFromPixel,
    multiplyHomographies(imageToScreen, imagePixelFromNdc)
  );
  return [
    warp[0], warp[1], 0, warp[2],
    warp[3], warp[4], 0, warp[5],
    0, 0, 1, 0,
    warp[6], warp[7], 0, warp[8]
  ];
}

function multiplyMat4(left: Mat4, right: Mat4): Mat4 {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        left[row]! * right[column * 4]! +
        left[4 + row]! * right[column * 4 + 1]! +
        left[8 + row]! * right[column * 4 + 2]! +
        left[12 + row]! * right[column * 4 + 3]!;
    }
  }
  return result as unknown as Mat4;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
