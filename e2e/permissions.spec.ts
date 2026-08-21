import { expect, test } from "@playwright/test";
import {
  completeCalibration,
  installMobileStubs,
  invokeHarness
} from "./fixtures/fakeMobile";

test("recovers from a denied camera gesture", async ({ page }) => {
  await installMobileStubs(page);
  await page.goto("/e2e.html?scenario=permission-denied");
  await page.getByRole("button", { name: /use my location/i }).click();
  await page.getByRole("button", { name: /choose city museum/i }).click();
  await page.getByRole("button", { name: /start ar walk/i }).click();
  await page.getByRole("button", { name: /enable camera and sensors/i }).click();
  await expect(page.getByRole("alert")).toContainText(/allow camera access/i);
  await page.getByRole("button", { name: /try permissions again/i }).click();
  await expect(
    page.getByRole("heading", { name: /align route to the road/i })
  ).toBeVisible();
});

test("stops AR and returns to preview when tracking is unavailable", async ({ page }) => {
  await installMobileStubs(page);
  await page.goto("/e2e.html");
  await completeCalibration(page);
  await invokeHarness(page, "unavailable");
  await expect(page.getByRole("heading", { name: "City Museum" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(/opencv could not initialize/i);
  await expect(page.getByLabel(/augmented reality navigation view/i)).toHaveCount(0);
});
