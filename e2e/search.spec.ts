import { expect } from "@playwright/test";
import { test } from "./fixtures/previewTest";

const suggestion = {
  placeId: "openstreetmap:venue:library",
  name: "Central Library",
  formattedAddress: "Central Library, Test City",
  location: { lat: 22.5709, lng: 88.36 }
};

test("clears a previous search failure when input changes and results recover", async ({ page }) => {
  await page.route("**/api/search", async (route) => {
    const { query } = route.request().postDataJSON() as { query: string };
    await route.fulfill(query === "Fail" ? {
      status: 502,
      json: { code: "SEARCH_UPSTREAM", message: "Destination search could not be completed." }
    } : { json: { suggestions: [suggestion] } });
  });
  await page.goto("/");
  const input = page.locator(".destination-search").getByRole("searchbox", { name: "Destination" });
  await input.fill("Fail");
  await expect(page.getByRole("alert")).toHaveText(/Destination search could not be completed/);
  await input.fill("Library");
  await expect(page.getByRole("button", { name: /Central Library/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await input.fill("Fail");
  await expect(page.getByRole("alert")).toBeVisible();
  await input.fill("L");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".destination-result")).toHaveCount(0);
});

test("normalizes mobile location, suppresses short input, and renders the selected route", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (success) => success({
      coords: {
        latitude: 22.57, longitude: 88.36, accuracy: 15,
        altitude: 42, altitudeAccuracy: 8, heading: 90, speed: 0
      },
      timestamp: Date.now()
    } as GeolocationPosition);
  });
  const queries: unknown[] = [];
  await page.route("**/api/search", async (route) => {
    const body = route.request().postDataJSON() as { query: string; origin: unknown };
    queries.push(body);
    await route.fulfill({ json: { suggestions: body.query === "No results" ? [] : [suggestion] } });
  });
  let selectedDestination: unknown;
  await page.route("**/api/routes", async (route) => {
    const body = route.request().postDataJSON() as { destination: unknown };
    selectedDestination = body.destination;
    await route.fulfill({ json: {
      origin: { lat: 22.57, lng: 88.36 },
      destination: suggestion.location,
      encodedPolyline: "oewhC_yhzOsD?",
      distanceMeters: 100, durationSeconds: 80,
      steps: [{ instruction: "Continue", maneuver: "STRAIGHT", distanceMeters: 100, polyline: "oewhC_yhzOsD?" }]
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.getByText(/Location ready.*15 m accuracy/)).toBeVisible();
  const input = page.locator(".destination-search").getByRole("searchbox", { name: "Destination" });
  await input.fill("L");
  // Observe longer than the 300ms debounce to prove no short request is sent.
  await page.waitForTimeout(400);
  await input.fill("");
  await page.waitForTimeout(400);
  expect(queries).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await input.fill("Li");
  await expect(page.getByRole("button", { name: /Central Library/ })).toBeVisible();
  expect(queries).toEqual([{ query: "Li", origin: { lat: 22.57, lng: 88.36 } }]);
  await input.fill("No results");
  await expect(page.getByText("No destinations found.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await input.fill("Library");
  await page.getByRole("button", { name: /Central Library/ }).click();
  await expect(page.getByRole("heading", { name: "Central Library" })).toBeVisible();
  expect(selectedDestination).toEqual({ placeId: suggestion.placeId, ...suggestion.location });
  await expect(page.getByRole("img", { name: "Route shape from current location to destination" })).toBeVisible();
  await expect(page.locator(".route-summary")).toContainText("100 m");
  await expect(page.locator(".route-summary")).toContainText("2 min");
  await page.getByRole("button", { name: "Start AR walk" }).click();
  await expect(page.getByRole("heading", { name: "Enable AR access" })).toBeVisible();
});
