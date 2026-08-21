# AR Walking Navigation MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-first walking navigator that searches Google destinations and projects a metrically calibrated, visually stabilized trail of green route bars onto the road on iPhone Safari and Android Chrome.

**Architecture:** A React/Vite mobile web app obtains Google walking geometry through a protected Vercel endpoint, converts it through ENU, route-local, calibrated-ground, camera, image, and screen frames, and renders it with Three.js. Device orientation and GPS provide the nominal global pose; OpenCV.js supplies a bounded residual homography for local visual attachment without controlling route progress or metric scale.

**Tech Stack:** Node.js 24, Vite 8.2.2, TypeScript 6.0.3, React 19.2.8, Three.js 0.185.1, OpenCV.js 5.0.0-release.1, gl-matrix 3.4.4, Google Maps JavaScript/Places and Routes APIs, Zod 4.4.3, Vitest 4.1.11, Testing Library 16.3.2, Playwright 1.62.1, Vercel Node functions.

**Spec:** `docs/superpowers/specs/2026-08-21-ar-walking-navigation-mvp-design.md`

## Global Constraints

- Preserve the exact coordinate order: ENU → route-local → calibrated ground → camera → image → screen.
- GPS/map matching owns global route choice and progress; OpenCV never reroutes, advances, bends, or rescales the route.
- Metric scale comes only from the locked camera model and selected camera height; visual homography is a bounded post-projection correction.
- Support portrait phones equivalent to iPhone 12/Pixel 6 or newer, iOS 17+ Safari, and Android Chrome 120+.
- Require HTTPS for camera, geolocation, and device-orientation access.
- Process camera frames, raw image points, and visual features locally; never upload or persist them.
- Use no paid WebAR SDK, native ARKit/ARCore, semantic road detection, persistent anchors, or zero-drift claims.
- Treat FOV, feature, inlier, reprojection, and sensor-disagreement values as configurable experimental defaults.
- Use a maximum 1280×720 display stream and 480×270 tracking frames targeting 12–15 tracking FPS and at least 24 render FPS.
- Keep Google browser/server keys separate and restricted; enforce the quotas recorded in the spec.
- Follow TDD for every pure domain unit and adapter boundary. Run full tests, typecheck, lint, and build before completion.

## File Structure

```text
api/
  routes.ts                         # Protected Google Routes proxy
public/
  manifest.webmanifest             # Minimal install/full-screen metadata
src/
  app/App.tsx                       # Top-level navigation state composition
  app/app.css                       # Mobile-first visual system
  domain/types.ts                   # Shared immutable contracts from the spec
  route/geo.ts                      # ENU conversion and route-local transform
  route/polyline.ts                 # Decode, sample, tangent, and bar generation
  route/progress.ts                 # Map matching, arrival, deviation, smoothing
  google/mapsLoader.ts              # Browser Google library initialization
  google/routeClient.ts             # Typed /api/routes client
  google/routeSchemas.ts            # Zod request/response contracts
  components/SearchScreen.tsx       # Places autocomplete and destination state
  components/RoutePreview.tsx       # 2D map, time, distance, start action
  components/PermissionScreen.tsx   # Permission explanations and recovery
  components/CalibrationScreen.tsx  # Height choice, two taps, scan, lock
  components/NavigationHud.tsx      # Maneuver, quality, re-align/end controls
  device/permissions.ts             # Camera/location/motion permission adapter
  device/camera.ts                  # Rear camera and frame lifecycle
  device/location.ts                # Location permission, watch, and fresh fix
  device/orientation.ts             # Cross-browser orientation normalization
  geometry/intrinsics.ts            # Approximate K from dimensions/FOV
  geometry/displayTransform.ts      # Video-image to CSS-screen mapping
  geometry/groundCalibration.ts     # Ray-plane and two-point rigid fit
  calibration/calibrationMachine.ts # Height, taps, scan, and lock transitions
  tracking/quality.ts               # Experimental thresholds and hysteresis
  tracking/residualHomography.ts    # H_observed × inverse(H_sensor)
  tracking/OpenCvTracker.ts         # Main-thread tracker fallback
  tracking/tracker.worker.ts        # Worker protocol and OpenCV pipeline
  tracking/TrackerClient.ts         # Worker/fallback selection
  pose/PoseFusion.ts                # Nominal pose plus bounded visual residual
  navigation/navigationEngine.ts    # Progress, maneuver, deviation, arrival
  navigation/navigationMachine.ts   # Explicit lifecycle transitions
  ar/projection.ts                  # K/T/H/A projection utilities
  ar/routeRibbon.ts                 # Metric bars and turn-arrow mesh data
  ar/RouteRenderer.ts               # Three.js camera, bars, and shader lifecycle
  session/NavigationSession.ts      # Runtime adapters and deterministic teardown
  session/sessionStore.ts           # Session-only route recovery/cleanup
  main.tsx                          # React bootstrap
  test/fixtures/tracking/*.json     # Deterministic point/homography fixtures
  test/fakes/*.ts                   # Sensor and renderer test doubles
e2e/
  navigation.spec.ts                # Mocked browser journey
  permissions.spec.ts               # Cross-browser permission recovery
docs/
  device-testing.md                 # Outdoor device protocol and results table
```

---

### Task 1: Project Foundation and Shared Contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `vitest.setup.ts`
- Create: `eslint.config.js`
- Create: `index.html`
- Create: `.env.example`
- Create: `public/manifest.webmanifest`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/App.test.tsx`
- Create: `src/app/app.css`
- Create: `src/domain/types.ts`

**Interfaces:**
- Consumes: approved design spec.
- Produces: `App`, `GeoPoint`, `RoutePlan`, `RouteStep`, `LocalRoutePoint`, `RouteGroundPoint`, `CameraIntrinsics`, `GroundCalibration`, `VisualCorrection`, `TrackingQuality`, and `PoseEstimate` with the exact names and fields from the spec.

- [ ] **Step 1: Add toolchain configuration and a failing shell test**

Create `package.json` with these pinned dependency ranges and scripts:

```json
{
  "name": "ar-walking-navigation",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --pretty false",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@googlemaps/js-api-loader": "^2.1.1",
    "@googlemaps/polyline-codec": "^1.0.28",
    "@techstark/opencv-js": "5.0.0-release.1",
    "gl-matrix": "^3.4.4",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "three": "^0.185.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "^1.62.1",
    "@testing-library/jest-dom": "^7.0.1",
    "@testing-library/react": "^16.3.2",
    "@types/node": "^26.2.0",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@types/three": "^0.185.4",
    "@vitejs/plugin-react": "^6.1.0",
    "@vitest/coverage-v8": "^4.1.11",
    "eslint": "^10.8.1",
    "jsdom": "^29.0.1",
    "typescript": "6.0.3",
    "typescript-eslint": "^8.67.0",
    "vite": "^8.2.2",
    "vitest": "^4.1.11"
  }
}
```

Configure Vite/React, TypeScript strict mode, jsdom, Testing Library matchers, and flat ESLint. Add `src/app/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("starts with the walking safety and destination search screen", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /walk with ar/i })).toBeVisible();
    expect(screen.getByText(/never use while driving/i)).toBeVisible();
    expect(screen.getByLabelText(/destination/i)).toBeEnabled();
  });
});
```

- [ ] **Step 2: Install dependencies and verify the shell test fails**

Run: `npm install && npm test -- src/app/App.test.tsx`

Expected: FAIL because `src/app/App.tsx` does not exist.

- [ ] **Step 3: Add the minimal application shell and exact domain contracts**

Create `App.tsx` with an accessible heading, safety copy, and destination input. Add mobile-safe CSS using `100dvh`, safe-area insets, 44-pixel controls, and no fixed viewport assumptions. Create `src/domain/types.ts` by transcribing the spec contracts, including tuple `Mat3`/`Mat4`, and add these supporting types:

```ts
export type Destination = {
  placeId: string;
  name: string;
  formattedAddress: string;
  location: GeoPoint;
};

export type TrackingState = "locked" | "weak" | "realign";
export type NavigationStage =
  | "search" | "preview" | "permissions" | "calibration"
  | "navigating" | "weak" | "realigning" | "arrived" | "ended";
```

Create the manifest with `display: "standalone"`, portrait orientation, theme/background colors, and start URL `/`. `.env.example` must contain only:

```dotenv
VITE_GOOGLE_MAPS_BROWSER_KEY=
GOOGLE_ROUTES_SERVER_KEY=
```

- [ ] **Step 4: Verify foundation quality**

Run: `npm test -- src/app/App.test.tsx && npm run typecheck && npm run lint && npm run build`

Expected: one passing test, zero TypeScript/ESLint errors, and a successful Vite production build.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts vitest.setup.ts eslint.config.js index.html .env.example public src/main.tsx src/app src/domain
git commit -m "chore: scaffold AR walking web app"
```

---

### Task 2: Route Geometry, Sampling, and Progress

**Files:**
- Create: `src/route/geo.ts`
- Create: `src/route/geo.test.ts`
- Create: `src/route/polyline.ts`
- Create: `src/route/polyline.test.ts`
- Create: `src/route/progress.ts`
- Create: `src/route/progress.test.ts`

**Interfaces:**
- Consumes: `GeoPoint`, `LocalRoutePoint`, `RouteGroundPoint` from `src/domain/types.ts`.
- Produces: `toEnu(point, origin)`, `createRouteFrame(origin, tangentBearingRad)`, `toRouteLocal(point, frame)`, `decodeAndSampleRoute(encoded, spacingMeters)`, `nearestRouteProgress(position, route)`, `ProgressSmoother.update(targetMeters, dtSeconds)`, `isOffRoute(...)`, and `hasArrived(...)`.

- [ ] **Step 1: Write failing metric-geometry tests**

```ts
import { describe, expect, it } from "vitest";
import { toEnu, createRouteFrame, toRouteLocal } from "./geo";

describe("local route geometry", () => {
  it("converts nearby longitude east and latitude north into metres", () => {
    const origin = { lat: 22.5726, lng: 88.3639 };
    const east = toEnu({ lat: origin.lat, lng: origin.lng + 0.0001 }, origin);
    const north = toEnu({ lat: origin.lat + 0.0001, lng: origin.lng }, origin);
    expect(east.eastMeters).toBeGreaterThan(10);
    expect(east.northMeters).toBeCloseTo(0, 1);
    expect(north.northMeters).toBeGreaterThan(11);
  });

  it("maps the route tangent to positive route-local forward", () => {
    const frame = createRouteFrame({ eastMeters: 0, northMeters: 0, upMeters: 0 }, 0);
    expect(toRouteLocal({ eastMeters: 0, northMeters: 10, upMeters: 0 }, frame))
      .toMatchObject({ rightMeters: 0, forwardMeters: 10 });
  });
});
```

Add tests proving decoded points are resampled at 2.5 m, nearest progress interpolates inside a segment, progress never jumps faster than the configured walking bound, off-route requires three accurate readings, and arrival requires both 95 percent progress and 20 m proximity.

- [ ] **Step 2: Run the focused tests to prove they fail**

Run: `npm test -- src/route/geo.test.ts src/route/polyline.test.ts src/route/progress.test.ts`

Expected: FAIL because the route modules do not exist.

- [ ] **Step 3: Implement ENU and route-local transforms**

Use a WGS84 local tangent approximation suitable for walking distances:

```ts
const EARTH_RADIUS_METERS = 6_378_137;

export function toEnu(point: GeoPoint, origin: GeoPoint): LocalRoutePoint {
  const lat0 = origin.lat * Math.PI / 180;
  const dLat = (point.lat - origin.lat) * Math.PI / 180;
  const dLng = (point.lng - origin.lng) * Math.PI / 180;
  return {
    eastMeters: EARTH_RADIUS_METERS * Math.cos(lat0) * dLng,
    northMeters: EARTH_RADIUS_METERS * dLat,
    upMeters: (point.altitudeMeters ?? 0) - (origin.altitudeMeters ?? 0),
    routeDistanceMeters: 0
  };
}
```

Define route-local x as right, y as up, and z as forward. Keep all angles in radians internally.

- [ ] **Step 4: Implement polyline sampling and route progress**

Use `decode` from `@googlemaps/polyline-codec`. Walk each segment, carry leftover distance across segment boundaries, and emit exact cumulative `routeDistanceMeters`. Implement nearest-segment projection in ENU, returning progress, cross-track distance, and nearest point. `ProgressSmoother` must use a critically damped target filter with `timeConstantSeconds = 1.5` and clamp forward velocity to `2.5 m/s + reportedAccuracyMeters / max(dt, 1)`.

- [ ] **Step 5: Verify route behavior**

Run: `npm test -- src/route && npm run typecheck`

Expected: all route tests pass and no coordinate type is mixed with pixels.

- [ ] **Step 6: Commit**

```bash
git add src/route
git commit -m "feat: add metric walking route geometry"
```

---

### Task 3: Protected Google Route API, Destination Search, and Preview

**Files:**
- Create: `src/google/routeSchemas.ts`
- Create: `src/google/routeSchemas.test.ts`
- Create: `src/google/routeClient.ts`
- Create: `src/google/routeClient.test.ts`
- Create: `src/google/mapsLoader.ts`
- Create: `src/device/location.ts`
- Create: `src/device/location.test.ts`
- Create: `api/routes.ts`
- Create: `api/routes.test.ts`
- Create: `src/components/SearchScreen.tsx`
- Create: `src/components/SearchScreen.test.tsx`
- Create: `src/components/RoutePreview.tsx`
- Create: `src/components/RoutePreview.test.tsx`
- Modify: `src/app/App.tsx`

**Interfaces:**
- Consumes: `Destination`, `GeoPoint`, `RoutePlan` and route decoding from Tasks 1–2.
- Produces: `routeRequestSchema`, `routePlanSchema`, `requestWalkingRoute(input, signal)`, `loadGoogleLibraries()`, `SearchScreen({ onDestination })`, `RoutePreview({ route, onStart, onBack })`, and a Vercel Web Standard fetch handler in `api/routes.ts`.

- [ ] **Step 1: Write failing schema and request-mapping tests**

```ts
import { describe, expect, it } from "vitest";
import { routeRequestSchema } from "./routeSchemas";

describe("routeRequestSchema", () => {
  it("accepts a bounded walking origin and selected destination", () => {
    expect(routeRequestSchema.parse({
      origin: { lat: 22.5726, lng: 88.3639 },
      destination: {
        placeId: "ChIJ-valid-place-id",
        lat: 22.5826,
        lng: 88.3739
      }
    })).toBeDefined();
  });

  it("rejects invalid coordinates and oversized identifiers", () => {
    expect(() => routeRequestSchema.parse({
      origin: { lat: 999, lng: 88 },
      destination: { placeId: "x".repeat(513), lat: 22, lng: 88 }
    })).toThrow();
  });
});
```

Test the API's pure `buildGoogleRequest` helper for `travelMode: "WALK"`, location waypoints, and an exact field mask containing duration, distance, route polyline, step polylines, maneuvers, and instructions. Mock `fetch` to verify error/status mapping and `AbortSignal` propagation. Test a user-initiated current-location request, the 25-metre accuracy gate, denial recovery, and cancellation.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- src/google src/device/location.test.ts api/routes.test.ts`

Expected: FAIL because the schemas, client, and handler do not exist.

- [ ] **Step 3: Implement the protected route boundary**

Use Zod bounds `lat [-90,90]`, `lng [-180,180]`, `placeId 1..512`, and an 8 KB JSON body limit. Apply same-origin CORS and log only status, latency, and error category—never coordinates, place names, or polylines. The server calls:

```ts
await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": process.env.GOOGLE_ROUTES_SERVER_KEY!,
    "X-Goog-FieldMask": [
      "routes.duration",
      "routes.distanceMeters",
      "routes.polyline.encodedPolyline",
      "routes.legs.steps.distanceMeters",
      "routes.legs.steps.polyline.encodedPolyline",
      "routes.legs.steps.navigationInstruction"
    ].join(",")
  },
  body: JSON.stringify({
    origin: { location: { latLng: {
      latitude: input.origin.lat,
      longitude: input.origin.lng
    } } },
    destination: { location: { latLng: {
      latitude: input.destination.lat,
      longitude: input.destination.lng
    } } },
    travelMode: "WALK",
    polylineQuality: "HIGH_QUALITY"
  })
});
```

Normalize Google durations like `"932s"` to integer seconds. Return `400`, `413`, `502`, or `503` with `{ code, message }`; never echo the secret or raw Google response.

- [ ] **Step 4: Implement the browser Google adapter and UI**

Use `setOptions({ key, v: "weekly" })` and `importLibrary("places")`/`importLibrary("maps")` from `@googlemaps/js-api-loader`. Wrap Places autocomplete behind a `DestinationSearchAdapter` so tests inject a fake. On selection, fetch only `displayName`, `formattedAddress`, and `location`, then emit `Destination`. Require a **Use my location** gesture before route calculation, while keeping destination search usable if location is denied. Render a compact Google map and decoded route polyline in `RoutePreview`, with distance, duration, **Start AR walk**, and **Back**.

- [ ] **Step 5: Integrate search and preview states in App**

`App` owns only selected destination and loaded `RoutePlan` at this stage. Use an `AbortController` to cancel stale route requests and preserve the selected destination on retryable errors.

- [ ] **Step 6: Verify API and route UI**

Run: `npm test -- src/google src/device/location.test.ts src/components/SearchScreen.test.tsx src/components/RoutePreview.test.tsx api/routes.test.ts && npm run typecheck && npm run build`

Expected: schema/client/handler and search/preview tests pass; the browser bundle contains no server key.

- [ ] **Step 7: Commit**

```bash
git add api src/google src/device/location* src/components src/app/App.tsx
git commit -m "feat: add Google walking route search and preview"
```

## Task 4: Mobile Permissions, Camera, and Orientation Inputs

**Files:**
- Create: `src/device/permissions.ts`
- Create: `src/device/permissions.test.ts`
- Create: `src/device/camera.ts`
- Create: `src/device/camera.test.ts`
- Create: `src/device/orientation.ts`
- Create: `src/device/orientation.test.ts`
- Create: `src/components/PermissionScreen.tsx`
- Create: `src/components/PermissionScreen.test.tsx`
- Modify: `src/domain/types.ts`
- Modify: `src/app/App.tsx`

- [ ] **Step 1: Write failing permission and lifecycle tests**

Test three separate user-gesture operations: a fresh high-accuracy location fix, motion/orientation permission, and rear-camera startup. Cover iOS's optional `DeviceOrientationEvent.requestPermission`, Android's direct event path, denied permissions, a missing secure context, GPS accuracy worse than 25 metres, stream teardown, and visibility-driven pause/resume.

```ts
it("stops every camera track", () => {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
  stopMediaStream(stream);
  expect(stop).toHaveBeenCalledTimes(2);
});

it("converts webkit compass heading into clockwise radians", () => {
  expect(readCompassHeading({ webkitCompassHeading: 90 })).toBeCloseTo(Math.PI / 2);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- src/device src/components/PermissionScreen.test.tsx`

Expected: FAIL because the device adapters and screen do not exist.

- [ ] **Step 3: Implement narrow browser adapters**

`startRearCamera(video)` requests a rear stream capped at 1280×720 with `{ video: { facingMode: { ideal: "environment" } }, audio: false }`, assigns `srcObject`, awaits `play()`, and returns the stream. The location adapter uses high accuracy, a 5-second timeout, and a 1-second maximum age. Normalize orientation into a `DeviceOrientationSample` containing timestamp, compass heading, pitch, roll, and accuracy metadata without reading globals outside the adapter.

- [ ] **Step 4: Implement the permission screen and lifecycle cleanup**

Request permissions only after a visible **Enable camera and sensors** button click. Explain why each permission is needed and show a specific recovery message for denied location, camera, or motion. Stop tracks, geolocation watches, and listeners on unmount; pause camera/tracking when the document is hidden and resume only after it becomes visible.

- [ ] **Step 5: Verify permission behavior**

Run: `npm test -- src/device src/components/PermissionScreen.test.tsx && npm run typecheck && npm run lint`

Expected: all device adapter and permission UI tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/device src/components/PermissionScreen* src/domain/types.ts src/app/App.tsx
git commit -m "feat: add mobile camera and sensor permissions"
```

## Task 5: Metric Road Calibration and Display Geometry

**Files:**
- Create: `src/geometry/intrinsics.ts`
- Create: `src/geometry/intrinsics.test.ts`
- Create: `src/geometry/displayTransform.ts`
- Create: `src/geometry/displayTransform.test.ts`
- Create: `src/geometry/groundCalibration.ts`
- Create: `src/geometry/groundCalibration.test.ts`
- Create: `src/calibration/calibrationMachine.ts`
- Create: `src/calibration/calibrationMachine.test.ts`
- Create: `src/components/CalibrationScreen.tsx`
- Create: `src/components/CalibrationScreen.test.tsx`
- Create: `src/test/geometryFixtures.ts`
- Modify: `src/domain/types.ts`

- [ ] **Step 1: Write failing camera-geometry tests**

Use portrait 1080x1920 and landscape 1920x1080 fixtures. Assert that a 65-degree horizontal FOV creates the expected focal length, the optical center maps through `object-fit: cover`, ground intersections reject skyward/parallel rays, and ENU points preserve metre scale.

```ts
it("builds focal length from the configured horizontal FOV", () => {
  const k = buildApproximateIntrinsics(1920, 1080, 65);
  expect(k.fx).toBeCloseTo(1920 / (2 * Math.tan(65 * Math.PI / 360)));
  expect(k.fy).toBe(k.fx);
  expect(k.cx).toBe(960);
  expect(k.cy).toBe(540);
});
```

Test `DisplayTransform` in both directions so touch coordinates, camera pixels, and renderer pixels use one explicit mapping rather than duplicated CSS math.

- [ ] **Step 2: Write failing calibration state-machine tests**

Cover the exact flow `height -> near tap -> far tap -> standing scan -> locked`, rejected tap ordering, fewer than 20 stable scan samples, excessive angular motion, and explicit **Re-align** reset. Test height presets `1.2`, `1.4`, and `1.6` metres.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- src/geometry src/calibration src/components/CalibrationScreen.test.tsx`

Expected: FAIL because geometry and calibration modules do not exist.

- [ ] **Step 4: Implement one canonical geometry pipeline**

Use the invariant:

```text
ENU metres -> route-local metres -> calibrated ground frame -> camera frame
-> camera image pixels -> object-fit display pixels
```

`intersectImageRayWithGround` computes `t = -(n dot cameraOrigin + d) / (n dot ray)` and accepts only finite positive intersections. `projectGroundPoint` returns a discriminated result so callers must handle behind-camera and outside-viewport points. Keep the assumed FOV in one exported `CalibrationConfig` value.

- [ ] **Step 5: Implement calibration capture and quality gates**

The two ordered road taps establish a screen-space road direction, while user height and orientation samples establish metric ground scale and camera-to-ground pose. Require standing still during the scan; average orientation with circular heading math; store assumptions and residual quality in `CalibrationResult`. Lock the result for the navigation session and never silently recalibrate.

- [ ] **Step 6: Implement accessible calibration UI**

Render one instruction at a time, large tap targets, a visible height selector, tap markers, scan progress, retry reason, and the final **Start AR** action. Include the instruction to point at a flat visible stretch of road and remain on the sidewalk while calibrating.

- [ ] **Step 7: Verify calibration and geometry**

Run: `npm test -- src/geometry src/calibration src/components/CalibrationScreen.test.tsx && npm run typecheck && npm run lint`

Expected: deterministic portrait/landscape projections and every calibration transition pass.

- [ ] **Step 8: Commit**

```bash
git add src/geometry src/calibration src/components/CalibrationScreen* src/test/geometryFixtures.ts src/domain/types.ts
git commit -m "feat: add metric road calibration"
```

## Task 6: Visual Residual Tracking and Quality Gates

**Files:**
- Create: `src/tracking/types.ts`
- Create: `src/tracking/quality.ts`
- Create: `src/tracking/quality.test.ts`
- Create: `src/tracking/residualHomography.ts`
- Create: `src/tracking/residualHomography.test.ts`
- Create: `src/tracking/OpenCvTracker.ts`
- Create: `src/tracking/OpenCvTracker.test.ts`
- Create: `src/tracking/tracker.worker.ts`
- Create: `src/tracking/TrackerClient.ts`
- Create: `src/tracking/TrackerClient.test.ts`
- Create: `src/test/fixtures/tracking/good-sequence.json`
- Create: `src/test/fixtures/tracking/low-texture-sequence.json`
- Create: `src/test/fixtures/tracking/outlier-sequence.json`

- [ ] **Step 1: Write failing deterministic quality tests**

Use recorded numeric fixtures, not live camera frames. Test the approved experimental defaults: initial lock requires at least 30 candidate features and 15 RANSAC inliers; `weak` requires five consecutive frames with fewer than 15 inliers, inlier ratio below `0.55`, or median reprojection error above `3 px`; `realign` requires ten consecutive frames with fewer than 10 inliers or invalid motion. Add tested recovery hysteresis back to `locked`, and reject stale homographies older than `250 ms`.

```ts
it("does not recover from one lucky frame", () => {
  const gate = new TrackingQualityGate(DEFAULT_TRACKING_THRESHOLDS);
  for (let frame = 0; frame < 5; frame += 1) gate.update(badObservation);
  expect(gate.state).toBe("weak");
  gate.update(goodObservation);
  expect(gate.state).toBe("weak");
});
```

- [ ] **Step 2: Write failing residual-homography tests**

Assert `H_visual = H_observed * inverse(H_sensor)` within tolerance, normalization by `h33`, rejection of singular/non-finite matrices, identity output for sensor-only agreement, and a capped correction so visual tracking cannot change route progress or metric scale.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- src/tracking`

Expected: FAIL because tracking modules do not exist.

- [ ] **Step 4: Implement OpenCV behind a replaceable adapter**

Load OpenCV lazily after permissions. On a downscaled grayscale road ROI, run `goodFeaturesToTrack`, pyramidal Lucas-Kanade optical flow, forward/backward filtering, and `findHomography(..., RANSAC)`. Confine all `cv.Mat` allocation/deletion to `OpenCvTracker`; tests inject a fake adapter and verify deletion on success, tracking loss, and exceptions.

- [ ] **Step 5: Run tracking off the main render loop**

`TrackerClient` transfers `ImageBitmap` frames to `tracker.worker.ts`, permits only one in-flight frame, drops stale frames, and timestamps results. When workers or `OffscreenCanvas` are unavailable, use the same tracker interface on the main thread at a reduced cadence. If OpenCV initialization itself fails, report `unavailable`, hide the overlay, stop the unstable AR session, and return to route preview with a compatibility message.

- [ ] **Step 6: Verify tracking**

Run: `npm test -- src/tracking && npm run typecheck && npm run lint`

Expected: good, weak, outlier, stale, and cleanup cases pass deterministically.

- [ ] **Step 7: Commit**

```bash
git add src/tracking src/test/fixtures/tracking
git commit -m "feat: add visual residual road tracking"
```

## Task 7: Pose Fusion, GPS Progress, and Navigation Decisions

**Files:**
- Create: `src/pose/PoseFusion.ts`
- Create: `src/pose/PoseFusion.test.ts`
- Create: `src/navigation/navigationEngine.ts`
- Create: `src/navigation/navigationEngine.test.ts`
- Create: `src/navigation/navigationMachine.ts`
- Create: `src/navigation/navigationMachine.test.ts`
- Modify: `src/route/progress.ts`
- Modify: `src/domain/types.ts`

- [ ] **Step 1: Write failing fusion tests**

Test that fresh visual residuals stabilize fast sensor rotation, stale/weak visual estimates fade smoothly to identity, heading corrections are bounded, timestamp order is enforced, and no visual input can modify `routeProgressMeters`.

```ts
it("keeps global progress owned by GPS", () => {
  const fusion = new PoseFusion(testCalibration);
  fusion.updateGps({ ...gpsFix, routeProgressMeters: 42 });
  fusion.updateVisual({ ...visualResidual, translationPixels: [80, -20] });
  expect(fusion.snapshot().routeProgressMeters).toBe(42);
});
```

- [ ] **Step 2: Write failing navigation-decision tests**

Cover 1.5-second progress smoothing, monotonic tolerance for GPS jitter, off-route entry after consecutive fixes beyond the route corridor, recovery hysteresis, next-maneuver selection, arrival within the configured radius, and `realignRequired` when calibration/pose disagreement persists.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- src/pose src/navigation src/route/progress.test.ts`

Expected: FAIL because fusion and navigation decision modules do not exist.

- [ ] **Step 4: Implement bounded sensor/visual fusion**

Sensors provide the current camera orientation prior. Apply only the residual image-space homography from Task 6, with age-based decay and angular/corner-displacement clamps. Keep GPS position and snapped route progress in their own fields; do not infer forward walking distance from optical flow.

- [ ] **Step 5: Implement the pure navigation engine and state machine**

`navigationEngine.update(input)` returns route progress, remaining distance, next instruction, off-route status, tracking quality, and arrival. `navigationMachine` owns `preview -> permissions -> calibration -> navigating -> arrived`, plus recoverable `paused`, `permissionError`, `trackingWeak`, and `realign` substates. Every transition is unit-tested and has a user action.

- [ ] **Step 6: Verify pose and navigation behavior**

Run: `npm test -- src/pose src/navigation src/route && npm run typecheck && npm run lint`

Expected: pose fusion never owns global displacement and navigation state changes meet hysteresis rules.

- [ ] **Step 7: Commit**

```bash
git add src/pose src/navigation src/route/progress.ts src/domain/types.ts
git commit -m "feat: fuse pose and walking progress"
```

## Task 8: Three.js Road-Fixed Route Rendering

**Files:**
- Create: `src/ar/routeRibbon.ts`
- Create: `src/ar/routeRibbon.test.ts`
- Create: `src/ar/projection.ts`
- Create: `src/ar/projection.test.ts`
- Create: `src/ar/RouteRenderer.ts`
- Create: `src/ar/RouteRenderer.test.ts`
- Create: `src/components/ArViewport.tsx`
- Create: `src/components/ArViewport.test.tsx`
- Create: `src/test/fakes/FakeRenderer.ts`

- [ ] **Step 1: Write failing route-ribbon tests**

Sample only the visible route interval ahead of smoothed progress. Build alternating green bars/arrows in route-local metres with fixed physical width, segment joins, turn emphasis, and a maximum draw distance. Assert clipping behind the user and stable vertex counts for straight and curved fixtures.

- [ ] **Step 2: Write failing projection tests**

Use the shared calibration fixtures to assert known route-local ground points project to expected pixels, points behind the camera are removed, screen rotation and object-fit cover remain correct, and residual homography moves image pixels without changing route-local geometry.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- src/ar src/components/ArViewport.test.tsx`

Expected: FAIL because the renderer modules do not exist.

- [ ] **Step 4: Implement the renderer**

Create one Three.js scene with a transparent WebGL canvas above the `<video>` camera. Render route bars and maneuver arrows as ground-plane meshes in metric route-local coordinates. Update buffer geometry only when progress crosses a sampling threshold; update camera/view and residual image warp per animation frame. Cap device pixel ratio at `2` and dispose geometry, material, renderer, textures, and RAF on stop.

- [ ] **Step 5: Implement testable viewport lifecycle**

Inject a `RendererFactory` so jsdom tests use `FakeRenderer`. `ArViewport` owns video/canvas sizing with `ResizeObserver`, applies the canonical display transform, pauses RAF while hidden, and renders a non-WebGL fallback message if context creation fails.

- [ ] **Step 6: Verify projection and rendering lifecycle**

Run: `npm test -- src/ar src/components/ArViewport.test.tsx && npm run typecheck && npm run build`

Expected: geometry/projection fixtures, resize, pause, and resource-disposal tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/ar src/components/ArViewport* src/test/fakes/FakeRenderer.ts
git commit -m "feat: render route markers on the calibrated road"
```

## Task 9: End-to-End Navigation Session UI

**Files:**
- Create: `src/session/NavigationSession.ts`
- Create: `src/session/NavigationSession.test.ts`
- Create: `src/session/sessionStore.ts`
- Create: `src/session/sessionStore.test.ts`
- Create: `src/components/NavigationHud.tsx`
- Create: `src/components/NavigationHud.test.tsx`
- Create: `src/components/TrackingWarning.tsx`
- Create: `src/components/ArrivalScreen.tsx`
- Create: `src/app/App.integration.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css`

- [ ] **Step 1: Write a failing integrated happy-path test**

With fake Google, device, tracker, and renderer adapters, drive:

```text
search -> route preview -> grant permissions -> choose height -> two road taps
-> standing scan -> navigation -> GPS progress -> maneuver -> arrival
```

Assert that the camera starts only after the permission click, AR starts only after calibration locks, remaining distance falls from GPS progress, and all resources stop at arrival or exit.

- [ ] **Step 2: Write failing recovery-path tests**

Cover camera denial, sensor denial, poor GPS accuracy, route API retry, offline continuation after a route is loaded, low-texture warning, tracker unavailable, app background/foreground confidence check, off-route notice with explicit recalculate/keep choice, **Re-align**, route restart, thermal/render-pressure degradation, and WebGL failure. Every blocked state must explain the problem and provide a retry, back, or end action.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm test -- src/session src/components src/app/App.integration.test.tsx`

Expected: FAIL because the complete session UI does not exist.

- [ ] **Step 4: Implement session orchestration**

`NavigationSession` owns adapters and teardown while the pure state machine owns decisions. Feed GPS fixes to route progress, orientation to pose fusion, camera frames to tracking, and fused snapshots to the renderer. Use `AbortController`/explicit disposers for every asynchronous source and ignore callbacks after stop. `sessionStore` persists only the active route and non-sensitive navigation state, restores after a transient reload, and clears on **End**; it never stores frames, features, homographies, or location history.

- [ ] **Step 5: Implement the navigation HUD**

Keep the camera dominant. Show the next maneuver, distance to maneuver, remaining route distance, tracking quality, off-route/realign banners, a large **Exit** action, and the permanent walking-only safety label. Markers remain bright green with a dark edge for contrast; UI controls respect iOS safe-area insets.

- [ ] **Step 6: Verify the complete in-browser flow**

Run: `npm test -- src/session src/components src/app && npm run typecheck && npm run lint && npm run build`

Expected: happy-path and every recovery-path integration test pass; build output has no API secret.

- [ ] **Step 7: Commit**

```bash
git add src/session src/components src/app
git commit -m "feat: integrate the AR walking navigation session"
```

## Task 10: PWA Delivery, Browser E2E, and Physical-Device Checklist

**Files:**
- Create: `public/icons/app-icon.svg`
- Create: `src/sw.ts`
- Create: `playwright.config.ts`
- Create: `e2e/navigation.spec.ts`
- Create: `e2e/permissions.spec.ts`
- Create: `e2e/fixtures/fakeMobile.ts`
- Create: `vercel.json`
- Create: `docs/device-testing.md`
- Create: `README.md`
- Modify: `vite.config.ts`
- Modify: `src/main.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write failing mobile browser E2E tests**

Configure Chromium with a Pixel-class viewport and WebKit with an iPhone-class viewport. Stub the route endpoint, geolocation, orientation samples, camera stream, tracker output, and WebGL adapter. Test the happy path, rotation/resize, permission denial recovery, background/foreground, off-route, re-align, and arrival.

- [ ] **Step 2: Run E2E and confirm failure**

Run: `npm run e2e`

Expected: FAIL because Playwright configuration and the complete delivery surface are not present.

- [ ] **Step 3: Add installable PWA behavior without unsafe camera caching**

Register a minimal service worker that precaches versioned static assets and serves an offline shell, but never caches `/api/routes`, Google API traffic, camera frames, location data, calibration, or a completed route session. Add manifest icons and an update prompt; HTTPS remains mandatory outside localhost.

- [ ] **Step 4: Add deployment and security configuration**

Configure Vercel rewrites/functions, same-origin CORS, `Permissions-Policy`, and a Content Security Policy restricted to the app plus required Google Maps origins. Document separate `VITE_GOOGLE_MAPS_BROWSER_KEY` and `GOOGLE_ROUTES_SERVER_KEY`, browser-key HTTP referrer restrictions, server-key API restrictions, daily quotas of 500 Routes, 2,000 autocomplete, and 1,000 Dynamic Maps requests, quota alerts, and that Google Maps Platform usage requires billing even when monthly credits/free thresholds cover MVP traffic.

- [ ] **Step 5: Add operating and device-test documentation**

`README.md` includes setup, environment variables, scripts, architecture, privacy statement, limitations, and deployment. `docs/device-testing.md` has checkboxes for current iPhone Safari and Android Chrome on: straight/curved routes, portrait/landscape, bright/shadowed textured roads, walking motion, permission denial, tracking loss, re-align, off-route, arrival, thermal behavior, and 20-minute battery/session stability. State clearly: outdoor walking only, keep eyes on surroundings, never use while driving.

- [ ] **Step 6: Run the full automated verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build && npm run e2e`

Expected: all unit/integration/E2E checks pass in both configured browser projects.

- [ ] **Step 7: Inspect build and security boundaries**

Run:

Run: `rg -n "GOOGLE_ROUTES_SERVER_KEY|AIza" dist src public`

Expected: exit code `1`, meaning no server key or hard-coded Google key appears in browser assets.

Run: `git diff --check`

Expected: exit code `0` with no whitespace errors.

- [ ] **Step 8: Perform the physical-device acceptance pass**

Serve the production build over HTTPS, complete every checkbox in `docs/device-testing.md` on one current iPhone and one current Android phone, record browser/OS/device, and log any threshold changes with the captured fixture that justified them. Do not label road locking production-ready until this pass succeeds.

- [ ] **Step 9: Commit**

```bash
git add public src/sw.ts src/main.tsx vite.config.ts playwright.config.ts e2e vercel.json docs/device-testing.md README.md package.json package-lock.json
git commit -m "feat: prepare AR navigation MVP for mobile delivery"
```

## Final Review Checklist

- [ ] Every goal, non-goal, failure state, privacy rule, and geometry invariant in the approved design maps to a task and automated or physical-device check above.
- [ ] No `TODO`, `TBD`, placeholder implementation, fake production result, or unowned browser global remains.
- [ ] Camera, geolocation, device orientation, workers, animation frames, OpenCV matrices, WebGL resources, and fetch requests all have explicit teardown.
- [ ] Type names and units match across route, calibration, tracking, pose, navigation, and rendering boundaries; metres, radians, image pixels, and display pixels are never implicit.
- [ ] GPS alone owns global route progress; visual tracking is residual-only and cannot modify metric scale.
- [ ] Server credentials remain server-only, browser keys are restricted, request bodies are bounded, and errors do not leak upstream responses.
- [ ] Automated checks pass, followed by the documented iPhone and Android physical-device pass.
