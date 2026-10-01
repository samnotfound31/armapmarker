import polylineCodec from "@googlemaps/polyline-codec";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/previewTest";
import { alignActualCalibration, installSyntheticDevice } from "./fixtures/syntheticDevice";

const origin = { lat: 20.353, lng: 85.819 };
const metersPerLatitudeDegree = 111_319.49079327358;
const metersPerLongitudeDegree = metersPerLatitudeDegree * Math.cos(origin.lat * Math.PI / 180);

for (const [initialHeadingDeg, expectedCue] of [
  [90, "← Route left"],
  [180, "↶ Route behind — turn around"]
] as const) {
  test(`initial ${initialHeadingDeg}° geographic heading does not align a northbound route in front`, async ({ page }) => {
    test.setTimeout(75_000);
    await startRealGuidance(page, false, initialHeadingDeg);
    const diagnostics = page.getByLabel("AR diagnostics");
    await expect(diagnostics).toContainText("Geographic state: VALID");
    await expect(page.getByText(expectedCue, { exact: true })).toBeVisible();
    await expect(diagnostics).toContainText("Rendered: 0");
    await page.getByRole("button", { name: "Exit", exact: true }).click();
  });
}

test("geographic guidance does not rotate the route into view during camera turns and gates uncertain inputs", async ({ page }) => {
  test.setTimeout(75_000);
  await startRealGuidance(page, false);
  const diagnostics = page.getByLabel("AR diagnostics");
  await expect(diagnostics).toContainText("Geographic state: VALID");
  await expect(page.getByText("Visual tracking locked", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__SYNTHETIC_DEVICE__.overlayPixels)).toBeGreaterThan(20);
  // Rotating the phone cannot rotate geography back into the camera's center.
  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, { headingDeg: 270 }));
  await expect(page.getByText("← Route left", { exact: true })).toHaveCount(0);
  await expect(page.getByText("→ Route right", { exact: true })).toBeVisible();
  await expect(diagnostics).toContainText("Visible markers: 0");
  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, { headingDeg: 180 }));
  await expect(page.getByText("↶ Route behind — turn around", { exact: true })).toBeVisible();
  await expect(diagnostics).toContainText("Visible markers: 0");
  await expect.poll(() => page.evaluate(() => window.__SYNTHETIC_DEVICE__.overlayPixels)).toBe(0);
  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, { headingDeg: 90 }));
  await expect(page.getByText("← Route left", { exact: true })).toBeVisible();
  await expect(diagnostics).toContainText("Visible markers: 0");

  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, { headingAvailable: false }));
  await expect(diagnostics).toContainText("Geographic state: HEADING_UNCERTAIN");
  await expect(diagnostics).toContainText("Rendered: 0");
  await expect(page.getByText(/Heading uncertain —/)).toBeVisible();
  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, { headingAvailable: true, headingDeg: 0 }));
  await expect(diagnostics).toContainText("Geographic state: VALID");

  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, {
    accuracyMeters: 100, latitude: 20.3538, longitude: 85.8195
  }));
  await expect(diagnostics).toContainText("Geographic state: LOCATION_UNCERTAIN");
  await expect(diagnostics).toContainText("GPS: REJECTED");
  await expect(diagnostics).toContainText("Rendered: 0");
  await expect(diagnostics).toContainText(/Progress: 0\.0 m/);
  await expect(diagnostics).toContainText(/Cross-track: 0\.0 m/);

  await page.evaluate(() => Object.assign(window.__SYNTHETIC_DEVICE__, {
    accuracyMeters: 3, fixAgeMs: 60_000
  }));
  await expect(diagnostics).toContainText("Location: stale-location");
  await expect(diagnostics).toContainText("Geographic state: LOCATION_UNCERTAIN");
  await expect(diagnostics).toContainText("Rendered: 0");
  await page.getByRole("button", { name: "Exit", exact: true }).click();
});

test("walking sideways preserves lateral route displacement instead of snapping the camera onto the route", async ({ page }) => {
  test.setTimeout(75_000);
  await startRealGuidance(page, false);
  const diagnostics = page.getByLabel("AR diagnostics");
  await expect(diagnostics).toContainText("Geographic state: VALID");
  await expect(page.getByText("Visual tracking locked", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(diagnostics).toContainText(/Visible markers: [1-9][0-9]*/);
  const initialVisible = Number((await diagnostics.innerText()).match(/Visible markers: (\d+)/)?.[1]);

  // The route stays west of a camera moved east; matching still reports zero progress.
  for (const east of [1, 2, 3, 4]) {
    await setPosition(page, east, 0);
    await page.waitForTimeout(750);
  }
  await expect(diagnostics).toContainText(/Cross-track: 4\.0 m/);
  await expect(diagnostics).toContainText(/Progress: 0\.0 m/);
  const movedFourVisible = Number((await diagnostics.innerText()).match(/Visible markers: (\d+)/)?.[1]);
  for (const east of [6, 8, 10]) {
    await setPosition(page, east, 0);
    await page.waitForTimeout(750);
  }
  await expect(diagnostics).toContainText(/Cross-track: 10\.0 m/);
  await expect(diagnostics).toContainText(/Progress: 0\.0 m/);
  const movedTenVisible = Number((await diagnostics.innerText()).match(/Visible markers: (\d+)/)?.[1]);
  expect(movedFourVisible).toBeLessThan(initialVisible);
  expect(movedTenVisible).toBeLessThan(movedFourVisible);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
});

test("a missed geographic corner pauses real AR tracers and recalculates from the actual current position", async ({ page }) => {
  test.setTimeout(75_000);
  const routeOrigins = await startRealGuidance(page, true);
  const diagnostics = page.getByLabel("AR diagnostics");
  await expect(page.getByText("Visual tracking locked", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Turn right" })).toBeVisible();
  await expect(page.locator(".maneuver-distance")).toHaveText("20 m");

  // Continue north through the intended eastbound turn at 20m.
  for (let north = 3; north <= 36; north += 3) {
    await setPosition(page, 0, north);
    await page.waitForTimeout(850);
  }
  await expect(diagnostics).toContainText("Geographic state: DEVIATED");
  await expect(diagnostics).toContainText(/Progress: 20\.[0-9] m/);
  await expect(diagnostics).toContainText(/Cross-track: 16\.[0-9] m/);
  await expect(diagnostics).toContainText("Rendered: 0");
  await expect(page.getByText("Visual tracking locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recalculate route", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__SYNTHETIC_DEVICE__.overlayPixels)).toBe(0);

  await page.getByRole("button", { name: "Recalculate route", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start AR walk" })).toBeVisible();
  expect(routeOrigins).toHaveLength(2);
  expect(routeOrigins[1]!.lat).toBeCloseTo(origin.lat + 36 / metersPerLatitudeDegree, 8);
  expect(routeOrigins[1]!.lng).toBeCloseTo(origin.lng, 8);
});

async function startRealGuidance(page: Page, hasCorner: boolean, initialHeadingDeg = 0): Promise<{lat:number;lng:number}[]> {
  await installSyntheticDevice(page);
  const destination = hasCorner
    ? { lat: origin.lat + 20 / metersPerLatitudeDegree, lng: origin.lng + 20 / metersPerLongitudeDegree }
    : { lat: origin.lat + 100 / metersPerLatitudeDegree, lng: origin.lng };
  const routeOrigins: {lat:number;lng:number}[] = [];
  await page.route("**/api/search", (request) => request.fulfill({ json: {
    suggestions: [{ placeId:"test-library", name:"KIIT Central Library", formattedAddress:"Campus library", location:destination }]
  } }));
  await page.route("**/api/routes", (request) => {
    const body = request.request().postDataJSON() as { origin:{lat:number;lng:number} };
    routeOrigins.push(body.origin);
    const points: [number,number][] = [[body.origin.lat,body.origin.lng]];
    if (hasCorner && routeOrigins.length === 1) points.push([destination.lat,origin.lng]);
    points.push([destination.lat,destination.lng]);
    return request.fulfill({ json: {
      origin:body.origin, destination,
      encodedPolyline:polylineCodec.encode(points), distanceMeters:hasCorner?43:100, durationSeconds:80,
      steps: hasCorner && routeOrigins.length === 1 ? [
        {instruction:"Continue north", maneuver:"STRAIGHT", distanceMeters:22, polyline:polylineCodec.encode(points.slice(0,2))},
        {instruction:"Turn right", maneuver:"TURN_RIGHT", distanceMeters:21, polyline:polylineCodec.encode(points.slice(1))}
      ] : [{instruction:"Continue",maneuver:"STRAIGHT",distanceMeters:100,polyline:polylineCodec.encode(points)}]
    } });
  });
  await page.goto("/?arDebug=1");
  await page.evaluate((headingDeg) => Object.assign(window.__SYNTHETIC_DEVICE__, {
    accuracyMeters:3, headingDeg
  }), initialHeadingDeg);
  await page.getByRole("button", { name:"Use my location" }).click();
  await page.getByRole("searchbox", { name:"Destination" }).fill("KIIT Central Library");
  await page.getByRole("button", { name:/KIIT Central Library/ }).first().click();
  await expect(page.getByRole("heading", { name:"KIIT Central Library" })).toBeVisible();
  await page.getByRole("button", { name:"Start AR walk" }).click();
  await page.getByRole("button", { name:"Enable camera and sensors" }).click();
  await alignActualCalibration(page);
  return routeOrigins;
}

async function setPosition(page: Page, eastMeters: number, northMeters: number): Promise<void> {
  const latitude = origin.lat + northMeters / metersPerLatitudeDegree;
  const longitude = origin.lng + eastMeters / metersPerLongitudeDegree;
  await page.evaluate(({latitude,longitude}) => {
    Object.assign(window.__SYNTHETIC_DEVICE__, {latitude,longitude});
  }, {latitude,longitude});
}
