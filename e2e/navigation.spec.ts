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
