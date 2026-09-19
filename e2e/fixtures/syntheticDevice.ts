import { expect, type Page } from "@playwright/test";

// Only the hardware boundary is synthetic. Camera playback/metadata, calibration,
// OpenCV, worker tracking, session management and Three.js remain real.
export async function installSyntheticDevice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // A local self-signed certificate cannot validate a service-worker fetch.
    // Keep service workers enabled for the real HTTPS Preview run.
    if (location.hostname === "127.0.0.1") {
      Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
    }
    Object.defineProperty(Object.getPrototypeOf(screen.orientation), "angle", {
      configurable: true, get: () => 0
    });
    const state = {
      cameraCalls: 0, orientationPrompts: 0, motionPrompts: 0,
      permissionsWithoutGesture: 0, watches: new Map<number, number>(),
      streams: [] as MediaStream[], textured: true
    };
    Object.assign(window, { __SYNTHETIC_DEVICE__: state });
    const fix = () => ({
      coords: {
        latitude: 20.353, longitude: 85.819, accuracy: 15,
        altitude: 42, altitudeAccuracy: 8, heading: 0, speed: 0
      }, timestamp: Date.now()
    } as GeolocationPosition);
    navigator.geolocation.getCurrentPosition = (success) => success(fix());
    navigator.geolocation.watchPosition = (success) => {
      const id = window.setInterval(() => success(fix()), 250);
      state.watches.set(id, id);
      return id;
    };
    navigator.geolocation.clearWatch = (id) => {
      clearInterval(id);
      state.watches.delete(id);
    };
    const recordGesture = () => {
      if (!navigator.userActivation.isActive) state.permissionsWithoutGesture++;
    };
    Object.defineProperty(DeviceOrientationEvent, "requestPermission", {
      configurable: true,
      value: async () => { recordGesture(); state.orientationPrompts++; return "granted"; }
    });
    Object.defineProperty(DeviceMotionEvent, "requestPermission", {
      configurable: true,
      value: async () => { recordGesture(); state.motionPrompts++; return "granted"; }
    });
    window.setInterval(() => {
      if (!state.orientationPrompts) return;
      const event = new Event("deviceorientation");
      Object.assign(event, { alpha: 0, beta: 80, gamma: 0, absolute: true });
      window.dispatchEvent(event);
    }, 50);
    Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => {
      recordGesture();
      state.cameraCalls++;
      const canvas = document.createElement("canvas");
      canvas.width = 720;
      canvas.height = 1280;
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        ctx.fillStyle = "#222";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!state.textured) return;
        for (let y = 0; y < canvas.height; y += 24) {
          for (let x = 0; x < canvas.width; x += 24) {
            const shade = 70 + ((x * 17 + y * 29) % 180);
            ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
            ctx.fillRect(x + 4, y + 4, 10, 10);
          }
        }
      };
      draw();
      const stream = canvas.captureStream(20);
      const timer = window.setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === "ended")) {
          clearInterval(timer);
          return;
        }
        draw();
      }, 50);
      state.streams.push(stream);
      return stream;
    };
  });
}

export async function alignActualCalibration(page: Page): Promise<void> {
  await page.getByRole("button", { name: /chest.*1\.4 m/i }).click();
  await page.getByRole("button", { name: /capture standing pose/i }).click();
  const road = page.getByRole("button", { name: /road calibration view/i });
  await expect(road).toBeVisible();
  const box = (await road.boundingBox())!;
  await road.click({ position: { x: box.width / 2, y: box.height * 0.85 } });
  await expect(page.getByText("Tap a far point on the same path centre.")).toBeVisible();
  await road.click({ position: { x: box.width / 2, y: box.height * 0.5 } });
  await expect(page.getByRole("button", { name: "Scan road features" })).toBeVisible();
  await page.getByRole("button", { name: "Scan road features" }).click();
  await expect(page.getByRole("button", { name: /lock route.*start AR/i })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /lock route.*start AR/i }).click();
  await expect(page.getByLabel("Augmented reality navigation view")).toBeVisible();
}

declare global {
  interface Window {
    __SYNTHETIC_DEVICE__: {
      cameraCalls: number;
      orientationPrompts: number;
      motionPrompts: number;
      permissionsWithoutGesture: number;
      watches: Map<number, number>;
      streams: MediaStream[];
      textured: boolean;
    };
  }
}
