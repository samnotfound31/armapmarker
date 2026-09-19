import type { Mat3 } from "../src/domain/types";
import { loadOpenCvTracker } from "../src/tracking/OpenCvTracker";

type RuntimeSmokeResult = {
  status: "ready" | "tracked" | "error";
  securityViolations: string[];
  runtimeLoaded?: boolean;
  trackerResult?: {
    status: string;
    featureCount: number;
    inlierCount: number;
    qualityState: string;
    homography: Mat3 | null;
  };
  cleanupVerified?: boolean;
  error?: string;
};

const status = document.querySelector<HTMLOutputElement>("#runtime-status")!;
const securityViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => {
  securityViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
});

void run();

async function run(): Promise<void> {
  let tracker: Awaited<ReturnType<typeof loadOpenCvTracker>> | null = null;
  try {
    tracker = await loadOpenCvTracker();
    const mode = new URLSearchParams(location.search).get("mode");
    if (mode === "initialize") {
      tracker.dispose();
      const cleanupVerified = await rejectsAfterDispose(
        tracker,
        new ImageData(1, 1),
        1000
      );
      publish({
        status: "ready",
        runtimeLoaded: true,
        cleanupVerified,
        securityViolations
      });
      return;
    }

    const [firstFrame, secondFrame] = deterministicProjectiveFrames();
    await tracker.process(firstFrame, 1000, IDENTITY);
    let result = await tracker.process(secondFrame, 1033, IDENTITY);
    if (mode === "texture-loss") {
      const blank = new ImageData(firstFrame.width, firstFrame.height);
      for (let index = 0; index < 12; index++) {
        result = await tracker.process(blank, 1066 + index * 33, IDENTITY);
      }
    }
    tracker.dispose();
    const cleanupVerified = await rejectsAfterDispose(tracker, firstFrame, 1066);
    publish({
      status: "tracked",
      runtimeLoaded: true,
      trackerResult: {
        status: result.status,
        featureCount: result.quality.featureCount,
        inlierCount: result.quality.inlierCount,
        qualityState: result.quality.state,
        homography: result.visualHomography
      },
      cleanupVerified,
      securityViolations
    });
  } catch (error) {
    tracker?.dispose();
    publish({
      status: "error",
      securityViolations,
      error:
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error)
    });
  }
}

async function rejectsAfterDispose(
  tracker: Awaited<ReturnType<typeof loadOpenCvTracker>>,
  frame: ImageData,
  timestampMs: number
): Promise<boolean> {
  return tracker
    .process(frame, timestampMs, IDENTITY)
    .then(() => false)
    .catch((error: unknown) =>
      error instanceof Error && /disposed/i.test(error.message)
    );
}

function publish(result: RuntimeSmokeResult): void {
  window.__OPENCV_RUNTIME_SMOKE__ = result;
  status.dataset.status = result.status;
  status.textContent = JSON.stringify(result);
}

function deterministicProjectiveFrames(): [ImageData, ImageData] {
  const width = 320;
  const height = 240;
  const first = new ImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const gridX = Math.floor(x / 12);
      const gridY = Math.floor(y / 12);
      const checker = (gridX + gridY) % 2 === 0 ? 52 : 18;
      const speckle = ((x * 29 + y * 47 + x * y * 3) % 31) - 15;
      const roadTexture = y >= 88 ? checker + speckle : 24;
      first.data[offset] = roadTexture;
      first.data[offset + 1] = roadTexture;
      first.data[offset + 2] = roadTexture;
      first.data[offset + 3] = 255;
    }
  }
  for (let y = 98; y < height - 6; y += 18) {
    for (let x = 8; x < width - 6; x += 20) {
      drawSquare(first, x, y, 6, (x + y) % 40 === 0 ? 245 : 190);
    }
  }

  const sourceToDestination: Mat3 = [
    1.004, 0.006, 0.00012,
    0.004, 0.997, -0.00006,
    4, 2, 1
  ];
  const destinationToSource = invertFixtureHomography(sourceToDestination);
  const second = new ImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = transform(destinationToSource, x, y);
      const sourceX = Math.round(source.x);
      const sourceY = Math.round(source.y);
      const destinationOffset = (y * width + x) * 4;
      if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) {
        const sourceOffset = (sourceY * width + sourceX) * 4;
        second.data[destinationOffset] = first.data[sourceOffset]!;
        second.data[destinationOffset + 1] = first.data[sourceOffset + 1]!;
        second.data[destinationOffset + 2] = first.data[sourceOffset + 2]!;
      }
      second.data[destinationOffset + 3] = 255;
    }
  }
  return [first, second];
}

function drawSquare(
  image: ImageData,
  left: number,
  top: number,
  size: number,
  value: number
): void {
  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
    }
  }
}

function invertFixtureHomography(matrix: Mat3): Mat3 {
  const a = matrix[0];
  const b = matrix[3];
  const c = matrix[6];
  const d = matrix[1];
  const e = matrix[4];
  const f = matrix[7];
  const g = matrix[2];
  const h = matrix[5];
  const i = matrix[8];
  const determinant =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / determinant,
    (f * g - d * i) / determinant,
    (d * h - e * g) / determinant,
    (c * h - b * i) / determinant,
    (a * i - c * g) / determinant,
    (b * g - a * h) / determinant,
    (b * f - c * e) / determinant,
    (c * d - a * f) / determinant,
    (a * e - b * d) / determinant
  ];
}

function transform(matrix: Mat3, x: number, y: number) {
  const denominator = matrix[2] * x + matrix[5] * y + matrix[8];
  return {
    x: (matrix[0] * x + matrix[3] * y + matrix[6]) / denominator,
    y: (matrix[1] * x + matrix[4] * y + matrix[7]) / denominator
  };
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

declare global {
  interface Window {
    __OPENCV_RUNTIME_SMOKE__?: RuntimeSmokeResult;
  }
}
