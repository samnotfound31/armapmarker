import { expect, type Worker } from "@playwright/test";
import { test } from "./fixtures/previewTest";
import { alignActualCalibration, installSyntheticDevice } from "./fixtures/syntheticDevice";

test("real MVP runtime completes search, route, calibration, tracking, re-align and cleanup", async ({ page }) => {
  test.setTimeout(180_000);
  await installSyntheticDevice(page);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const apiRequests: string[] = [];
  const workers = new Set<Worker>();
  page.on("worker", (worker) => {
    workers.add(worker);
    worker.on("close", () => workers.delete(worker));
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      apiRequests.push(new URL(request.url()).pathname);
    }
  });
  if (!process.env.AR_PREVIEW_URL) {
    await page.route("**/api/search", (route) => route.fulfill({ json: {
      suggestions: [{ placeId: "library", name: "KIIT Central Library", formattedAddress: "KIIT Central Library",
        location: { lat: 20.354, lng: 85.819 } }]
    } }));
    await page.route("**/api/routes", (route) => route.fulfill({ json: {
      origin: { lat: 20.353, lng: 85.819 }, destination: { lat: 20.354, lng: 85.819 },
      encodedPolyline: "gef{BwoxjOgE?", distanceMeters: 111, durationSeconds: 80,
      steps: [{ instruction: "Continue", maneuver: "STRAIGHT", distanceMeters: 111, polyline: "gef{BwoxjOgE?" }]
    } }));
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.getByText(/Location ready.*15 m accuracy/)).toBeVisible();
  const searchWait = page.waitForResponse((response) => response.url().endsWith("/api/search"));
  await page.getByRole("searchbox", { name: "Destination" }).fill("KIIT Central Library");
  const search = await searchWait;
  expect(search.status()).toBe(200);
  expect(Object.keys(search.request().postDataJSON().origin).sort()).toEqual(["lat", "lng"]);
  const routeWait = page.waitForResponse((response) => response.url().endsWith("/api/routes"));
  await page.getByRole("button", { name: /KIIT Central Library/ }).first().click();
  const routeResponse = await routeWait;
  expect(routeResponse.status()).toBe(200);
  const route = await routeResponse.json();
  expect(route.distanceMeters).toBeGreaterThan(0);
  expect(route.durationSeconds).toBeGreaterThan(0);
  expect(route.steps.length).toBeGreaterThan(0);
  expect(route.encodedPolyline.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "KIIT Central Library" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Route shape from current location to destination" })).toBeVisible();
  await expect(page.locator(".route-summary")).toContainText("min");
  await page.getByRole("button", { name: "Start AR walk" }).click();
  expect(await page.evaluate(() => window.__SYNTHETIC_DEVICE__.cameraCalls)).toBe(0);
  await page.getByRole("button", { name: "Enable camera and sensors" }).click();
  await expect(page.getByRole("heading", { name: "Align route to the road" })).toBeVisible();
  expect(await page.evaluate(() => {
    const state = window.__SYNTHETIC_DEVICE__;
    return [state.cameraCalls, state.orientationPrompts, state.motionPrompts, state.permissionsWithoutGesture];
  })).toEqual([1, 1, 1, 0]);
  await alignActualCalibration(page);
  await expect(page.getByText("Tracking locked", { exact: true })).toBeVisible({ timeout: 30_000 });
  const videoReady = await page.getByLabel("Rear camera view").evaluate((element) => {
    const video = element as HTMLVideoElement;
    return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
  });
  expect(videoReady).toBe(true);
  expect(await page.locator("canvas.ar-overlay").evaluate((element) =>
    (element as HTMLCanvasElement).getContext("webgl2")!.getError()
  )).toBe(0);
  // Removing the synthetic texture must lead through weak to realign.
  await page.evaluate(() => { window.__SYNTHETIC_DEVICE__.textured = false; });
  await expect(page.getByRole("button", { name: "Re-align", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Re-align", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Align route to the road" })).toBeVisible();
  await page.evaluate(() => { window.__SYNTHETIC_DEVICE__.textured = true; });
  await alignActualCalibration(page);
  await expect(page.getByText("Tracking locked", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Where are you walking?" })).toBeVisible();
  expect(await page.evaluate(() => ({
    activeWatches: window.__SYNTHETIC_DEVICE__.watches.size,
    tracksEnded: window.__SYNTHETIC_DEVICE__.streams.every((stream) =>
      stream.getTracks().every((track) => track.readyState === "ended"))
  }))).toEqual({ activeWatches: 0, tracksEnded: true });
  expect(apiRequests).toEqual(["/api/search", "/api/routes"]);
  await expect.poll(() => workers.size).toBe(0);
  expect(browserErrors).toEqual([]);
});
