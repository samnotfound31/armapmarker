import { expect, test } from "@playwright/test";
import {
  completeCalibration,
  completeRoadAlignment,
  installMobileStubs,
  invokeHarness
} from "./fixtures/fakeMobile";

test.beforeEach(async ({ page }) => {
  await installMobileStubs(page);
  await page.goto("/e2e.html");
});

test("walks from search through AR maneuver to arrival", async ({ page }) => {
  await completeCalibration(page);
  await expect(page.getByRole("heading", { name: /turn left/i })).toBeVisible();
  await expect(page.getByText(/82 m remaining/i)).toBeVisible();

  await invokeHarness(page, "offRoute");
  await expect(page.getByText(/off the walking route/i)).toBeVisible();
  await page.getByRole("button", { name: /keep current route/i }).click();

  await invokeHarness(page, "arrive");
  await expect(
    page.getByRole("heading", { name: /you arrived at city museum/i })
  ).toBeVisible();
});

test("starts the real Three.js overlay before route geometry is populated", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/e2e.html?scenario=real-renderer");
  await completeCalibration(page);

  // Let the actual renderer initialize and draw its first route frames.
  const webglError = await page.locator("canvas.ar-overlay").evaluate(async (canvas) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const context = (canvas as HTMLCanvasElement).getContext("webgl2");
    if (!context) throw new Error("The route overlay has no WebGL2 context.");
    return context.getError();
  });

  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
  await expect(page.getByLabel(/augmented reality navigation view/i)).toBeVisible();
  await expect(page.getByText(/AR overlay stopped/i)).toHaveCount(0);
});

test("survives rotation, backgrounding, and explicit re-alignment", async ({
  page
}) => {
  await completeCalibration(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(
    page.getByRole("heading", { name: /align route to the road/i })
  ).toBeVisible();
  await expect(
    page.getByLabel(/augmented reality navigation view/i)
  ).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await completeRoadAlignment(page);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("heading", { name: /navigation paused/i })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("heading", { name: /align route to the road/i })
  ).toBeVisible();
  await completeRoadAlignment(page);

  await invokeHarness(page, "realign");
  await page.getByRole("button", { name: /re-align/i }).click();
  await expect(
    page.getByRole("heading", { name: /align route to the road/i })
  ).toBeVisible();
});
