import type { CameraIntrinsics, Mat3, Mat4 } from "../../domain/types";
import type {
  RouteGeometryBuffers,
  RouteRenderBackend,
  RouteView
} from "../../ar/RouteRenderer";

export class FakeRenderer implements RouteRenderBackend {
  resizeCalls: Array<{ widthPx: number; heightPx: number; pixelRatio: number }> = [];
  geometryCalls: RouteGeometryBuffers[] = [];
  viewCalls: RouteView[] = [];
  renderCount = 0;
  disposeCount = 0;

  resize(widthPx: number, heightPx: number, pixelRatio: number): void {
    this.resizeCalls.push({ widthPx, heightPx, pixelRatio });
  }

  updateGeometry(geometry: RouteGeometryBuffers): void {
    this.geometryCalls.push(geometry);
  }

  updateView(view: {
    cameraFromRoute: Mat4;
    intrinsics: CameraIntrinsics;
    imageToScreen: Mat3;
    visualHomography: Mat3;
    screenWidthPx: number;
    screenHeightPx: number;
  }): void {
    this.viewCalls.push(view);
  }

  render(): void {
    this.renderCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}
