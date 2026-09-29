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
      streams: [] as MediaStream[], textured: true, overlayPixels: 0,
      pitch: 80, roll: 0, headingDeg: 0, headingAvailable: true,
      latitude: 20.353, longitude: 85.819, accuracyMeters: 15, fixAgeMs: 0
    };
    Object.assign(window, { __SYNTHETIC_DEVICE__: state });
    // Observe actual overlay pixels immediately after drawing (the default
    // framebuffer need not be preserved between frames). Never sample video.
    let lastRead = 0;
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function(...args) {
      clear.apply(this, args);
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.classList.contains("ar-overlay") && performance.now() - lastRead > 450) {
        state.overlayPixels = 0;
      }
    };
    const drawElements = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function(...args) {
      drawElements.apply(this, args);
      if (!(this.canvas instanceof HTMLCanvasElement) || !this.canvas.classList.contains("ar-overlay") || performance.now() - lastRead < 250) return;
      lastRead = performance.now();
      queueMicrotask(() => {
      const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
      this.readPixels(0,0,this.drawingBufferWidth,this.drawingBufferHeight,this.RGBA,this.UNSIGNED_BYTE,pixels);
      let green = 0;
      for (let i=0;i<pixels.length;i+=16) {
        if (pixels[i+1]! > pixels[i]! * 1.5 && pixels[i+3]! > 20) {
          green++;
        }
      }
      state.overlayPixels = green;
      });
    };
    const fix = () => ({
      coords: {
        latitude: state.latitude, longitude: state.longitude, accuracy: state.accuracyMeters,
        altitude: 42, altitudeAccuracy: 8, heading: 0, speed: 0
      }, timestamp: Date.now() - state.fixAgeMs
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
      Object.assign(event, {
        alpha: 0, beta: state.pitch, gamma: state.roll, absolute: false,
        ...(state.headingAvailable ? {
          webkitCompassHeading: state.headingDeg,
          webkitCompassAccuracy: 5
        } : {})
      });
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
  const road = page.getByRole("button", { name: /road calibration view/i });
  await expect(road).toBeEnabled();
  const box = (await road.boundingBox())!;
  await road.click({ position: { x: box.width / 2, y: box.height * 0.7 } });
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
      overlayPixels: number;
      pitch: number;
      roll: number;
      headingDeg: number;
      headingAvailable: boolean;
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      fixAgeMs: number;
    };
  }
}
