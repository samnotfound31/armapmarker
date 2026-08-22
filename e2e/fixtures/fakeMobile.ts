import { expect, type Page } from "@playwright/test";

const ROUTE_POLYLINE = "oewhC_yhzOsD?";

export async function installMobileStubs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const streams = new WeakMap<HTMLMediaElement, MediaProvider | null>();
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() {
        return streams.get(this as HTMLMediaElement) ?? null;
      },
      set(value: MediaProvider | null) {
        streams.set(this as HTMLMediaElement, value);
      }
    });
  });
  await page.route("**/api/routes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        origin: { lat: 22.57, lng: 88.36 },
        destination: { lat: 22.5709, lng: 88.36 },
        encodedPolyline: ROUTE_POLYLINE,
        distanceMeters: 100,
        durationSeconds: 80,
        steps: [
          {
            instruction: "Turn left",
            maneuver: "TURN_LEFT",
            distanceMeters: 100,
            polyline: ROUTE_POLYLINE
          }
        ]
      })
    });
  });
}

export async function completeCalibration(page: Page): Promise<void> {
  await page.getByRole("button", { name: /use my location/i }).click();
  await expect(page.getByText(/location ready/i)).toBeVisible();
  await page.getByRole("button", { name: /choose city museum/i }).click();
  await page.getByRole("button", { name: /start ar walk/i }).click();
  await page.getByRole("button", { name: /enable camera and sensors/i }).click();
  await expect(
    page.getByRole("heading", { name: /align route to the road/i })
  ).toBeVisible();
  await completeRoadAlignment(page);
}

export async function completeRoadAlignment(page: Page): Promise<void> {
  await page.getByRole("button", { name: /chest.*1\.4 m/i }).click();
  await page.getByRole("button", { name: /capture standing pose/i }).click();
  const road = page.getByRole("button", { name: /road calibration view/i });
  await road.click({ position: { x: 100, y: 70 } });
  await road.click({ position: { x: 100, y: 240 } });
  await page.getByRole("button", { name: /scan road features/i }).click();
  await page.getByRole("button", { name: /lock route.*start ar/i }).click();
  await expect(page.getByLabel(/augmented reality navigation view/i)).toBeVisible();
}

export async function invokeHarness(
  page: Page,
  action: "offRoute" | "weak" | "realign" | "arrive" | "unavailable"
): Promise<void> {
  await page.evaluate((nextAction) => {
    window.__AR_E2E__?.[nextAction]();
  }, action);
}

declare global {
  interface Window {
    __AR_E2E__?: Record<
      "offRoute" | "weak" | "realign" | "arrive" | "unavailable",
      () => void
    >;
  }
}
