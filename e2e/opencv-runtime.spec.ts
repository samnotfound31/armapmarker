import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/previewTest";

type RuntimeSmokeResult = {
  status: "ready" | "tracked" | "error";
  securityViolations: string[];
  runtimeLoaded?: boolean;
  trackerResult?: {
    status: string;
    featureCount: number;
    inlierCount: number;
    qualityState: string;
    homography: readonly number[] | null;
  };
  cleanupVerified?: boolean;
  error?: string;
};

const vercel = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
) as {
  headers: Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
};
const productionCsp = vercel.headers
  .find(({ source }) => source === "/(.*)")
  ?.headers.find(({ key }) => key === "Content-Security-Policy")?.value;

test("production CSP initializes the actual shipped OpenCV runtime", async ({ page }) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const response = await page.goto("/runtime-smoke.html?mode=initialize");

  expect(response?.headers()["content-security-policy"]).toBe(productionCsp);
  expect(productionCsp).toContain("'wasm-unsafe-eval'");
  expect(productionCsp).toContain("'unsafe-eval'");
  await expect(page.locator("#runtime-status")).not.toHaveAttribute("data-status", "starting", {
    timeout: 90_000
  });
  const result = await readResult(page);
  expect(result.status, result.error).toBe("ready");
  expect(result.runtimeLoaded).toBe(true);
  expect(result.securityViolations).toEqual([]);
  expect(result.cleanupVerified).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("actual OpenCV adapter tracks a deterministic projective frame pair and cleans up", async ({
  page
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/runtime-smoke.html?mode=track");

  await expect(page.locator("#runtime-status")).not.toHaveAttribute("data-status", "starting", {
    timeout: 90_000
  });
  const result = await readResult(page);
  expect(result.status, result.error).toBe("tracked");
  expect(result.trackerResult).toMatchObject({
    status: "tracked",
    featureCount: expect.any(Number),
    inlierCount: expect.any(Number)
  });
  expect(result.trackerResult!.featureCount).toBeGreaterThanOrEqual(30);
  expect(result.trackerResult!.inlierCount).toBeGreaterThanOrEqual(15);
  const homography = result.trackerResult!.homography!;
  expect(homography).toHaveLength(9);
  expect(homography.every(Number.isFinite)).toBe(true);
  expect(Math.abs(homography[2]!) + Math.abs(homography[5]!)).toBeGreaterThan(1e-7);
  expect(Math.hypot(homography[6]!, homography[7]!)).toBeLessThan(20);
  expect(result.cleanupVerified).toBe(true);
  expect(result.securityViolations).toEqual([]);
  expect(browserErrors).toEqual([]);
});

async function readResult(page: Page): Promise<RuntimeSmokeResult> {
  return page.evaluate(
    () =>
      (window as unknown as { __OPENCV_RUNTIME_SMOKE__: RuntimeSmokeResult })
        .__OPENCV_RUNTIME_SMOKE__
  );
}

test("actual OpenCV treats a textureless frame sequence as tracking loss, not a runtime crash", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/runtime-smoke.html?mode=texture-loss");
  await expect(page.locator("#runtime-status")).not.toHaveAttribute("data-status", "starting", { timeout: 90_000 });
  const result = await readResult(page);
  expect(result.status, result.error).toBe("tracked");
  expect(result.trackerResult).toMatchObject({ status: "lost", featureCount: 0, inlierCount: 0, qualityState: "realign" });
  expect(result.cleanupVerified).toBe(true);
  expect(result.securityViolations).toEqual([]);
});
