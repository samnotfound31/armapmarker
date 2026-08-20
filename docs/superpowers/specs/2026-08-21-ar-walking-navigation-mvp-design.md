# AR Walking Navigation MVP Design

**Date:** 2026-08-21
**Status:** Approved direction; implementation pending spec review

## 1. Product Summary

Build a mobile web application that lets a pedestrian search for a destination with Google Places, calculate a Google walking route, open the rear camera, and see green arrows or bars appear as if they are painted on the road. The route graphics must remain visually attached to the calibrated road surface while the user moves the phone.

The MVP will use a free hybrid tracking approach. Google Maps Platform supplies destination and walking-route data. Browser geolocation and motion sensors establish global position and heading. OpenCV.js visual tracking stabilizes the calibrated road plane. Three.js renders the route graphics. No paid WebAR SDK is used.

This is a constrained WebAR experience rather than native ARKit/ARCore SLAM. It is designed for outdoor daytime use on textured roads and includes an explicit re-alignment flow when tracking confidence falls.

## 2. Goals

- Support iPhone Safari and Android Chrome without installing an application.
- Search for a real destination using Google Places autocomplete.
- Compute a walking route from the user's current position.
- Show a short 2D route preview before entering AR mode.
- Calibrate the route to the visible road in no more than ten seconds under suitable conditions.
- Render green route bars or chevrons along the next 30–40 metres of the walking path.
- Keep the overlay visually attached to the calibrated road during normal handheld camera movement.
- Advance the rendered path as the user walks and show the next maneuver and remaining distance.
- Detect weak tracking and ask the user to re-align instead of showing confidently wrong markers.
- Keep camera frames and visual features on the device.
- Keep Google Maps usage within configured free-usage quotas for the MVP.

## 3. Non-Goals

- Driving, cycling, or use while operating a vehicle.
- Indoor navigation, nighttime operation, or operation on featureless, reflective, flooded, or heavily occluded roads.
- Native-quality persistent world anchors or a guarantee that markers never drift.
- Semantic road, lane, curb, vehicle, pedestrian, or obstacle detection.
- Correct visual occlusion behind real objects.
- Voice guidance, background navigation, saved trips, accounts, social features, or analytics.
- Multiple route alternatives, waypoint planning, or automatic rerouting without confirmation.
- A native iOS or Android application.

## 4. Supported Environment

- Portrait-oriented phones equivalent to an iPhone 12, Pixel 6, or newer.
- iOS 17 or newer in Safari.
- Android Chrome 120 or newer.
- HTTPS deployment, because camera, geolocation, and sensor APIs require a secure context.
- Outdoor daylight with a reasonably textured road or footpath.
- GPS accuracy of 25 metres or better before AR mode may start.
- A billing-enabled Google Maps Platform project with API restrictions and hard quotas. For India-billed accounts, the current Essentials free-usage cap is documented by Google as 70,000 monthly requests per eligible SKU, but the app must not assume pricing will remain unchanged.

## 5. User Experience

### 5.1 Search and route preview

1. The landing screen explains that the experience is for walking and must not be used while driving.
2. The user taps **Use my location** and grants location permission.
3. The user searches for a destination through Google Places autocomplete.
4. The app requests one walking route from the current position to the selected place.
5. A compact 2D Google map previews the route with distance, estimated walking time, and destination name.
6. The user taps **Start AR walk**.

### 5.2 Permission sequence

Permission requests occur only after the user taps **Start AR walk**, satisfying iPhone's user-gesture requirements:

1. Rear camera access.
2. Motion and orientation access where the browser requires a separate prompt.
3. A fresh high-accuracy location reading.

The app explains why each permission is required before invoking the browser prompt. A denied permission never produces a blank camera screen; the user receives a specific recovery instruction.

### 5.3 Road calibration

1. The camera opens with a translucent placement guide in the lower half of the screen.
2. The user points the phone at the road in the direction of the first route segment.
3. The user taps the road point where the first route bar should begin. This establishes the visual ground origin and the route's lateral alignment.
4. The app asks the user to move the phone slowly left and right for three to five seconds.
5. OpenCV.js collects trackable road features and estimates the ground-plane transform.
6. The guide changes from translucent to green when at least 30 candidate features and 15 valid homography inliers are available.
7. The user taps **Lock route**. The current compass-to-route heading offset and the visual ground transform become the local AR origin.

If the road lacks enough features, the app asks the user to aim at a more textured patch or move closer; it does not begin navigation with a low-confidence lock.

### 5.4 AR navigation screen

The camera fills the viewport. The persistent interface contains only:

- A top instruction showing the next maneuver and distance to it.
- A small tracking-state indicator: **Locked**, **Weak**, or **Re-align**.
- Green bars or chevrons placed every 2.5 metres along the next 30–40 metres of route.
- A stronger curved or directional cue within 12 metres of a maneuver.
- A bottom **Re-align** action and an **End** action.

The closest bar begins approximately three metres in front of the user. Markers behind the user or more than 40 metres ahead are not rendered. Distant markers are smaller and less opaque, creating road depth without filling the scene.

As the user walks, the route matcher advances the current progress point. Passed bars disappear behind the user and new bars are generated ahead. Within 15 metres of the destination, the route becomes a green arrival target and the top instruction changes to **Destination ahead**. Arrival is declared when route progress exceeds 95 percent and the user is within 20 metres of the destination.

### 5.5 Tracking loss and route deviation

The overlay fades and freezes when tracking confidence is unsafe. It never continues drifting across the screen as if valid.

- **Weak:** fewer than 15 homography inliers, an inlier ratio below 0.55, or median reprojection error above 3 pixels for five consecutive processed frames. The overlay opacity falls to 50 percent while tracking attempts to recover.
- **Re-align:** fewer than 10 inliers or invalid motion for ten consecutive processed frames. The overlay disappears and the calibration guide returns while the route remains loaded.
- **Off route:** the map-matched location is more than 20 metres from the route for three consecutive GPS readings whose reported accuracy is 15 metres or better. The user is offered **Recalculate route** or **Keep current route**.

## 6. System Architecture

### 6.1 Browser application

The application is a Vite and TypeScript single-page web app with a small PWA manifest for full-screen mobile presentation. It is divided by responsibility:

- **Search controller:** Google Places autocomplete, selected place, and search errors.
- **Route client:** calls the server route endpoint and validates the returned route plan.
- **Route geometry:** decodes the polyline, converts latitude/longitude to a local East-North-Up frame, samples route points, calculates bearings, and map-matches user progress.
- **Permission controller:** camera, location, and iOS motion/orientation permission state.
- **Camera controller:** rear-camera stream lifecycle, resolution selection, and video-frame scheduling.
- **Visual tracker:** OpenCV.js feature detection, Lucas–Kanade optical flow, RANSAC homography, and tracking confidence.
- **Sensor adapter:** normalized location, compass, device orientation, and device motion events across Safari and Chrome.
- **Pose fusion:** combines the calibrated visual transform with smoothed sensor heading and GPS progress without snapping the overlay.
- **AR renderer:** Three.js scene, ground-plane arrow geometry, perspective projection, and frame rendering.
- **Navigation state machine:** search, preview, permissions, calibration, navigating, weak tracking, re-aligning, arrived, and ended states.
- **Session store:** keeps the current route and non-sensitive navigation state in `sessionStorage` so a transient browser reload can recover the trip. Camera frames and extracted visual features are never persisted.

These modules communicate through typed value objects rather than accessing each other's internal state.

### 6.2 Serverless route endpoint

One serverless endpoint receives a validated origin plus the selected destination place ID and coordinates, requests a Google walking route, and returns only the routing fields needed by the browser:

- Encoded route polyline.
- Route distance and duration.
- Step polylines, maneuver types, and localized instruction text.
- Destination coordinates.

The browser merges the selected place name from the autocomplete result into the returned route plan, avoiding an unnecessary Place Details lookup. The Google Routes key exists only in server environment variables. The browser Places key is separately restricted by HTTPS referrer and enabled API. The endpoint rejects invalid coordinates, payloads over 8 KB, and non-walking requests.

No database is required. The endpoint sends no camera or sensor data other than the route origin coordinates explicitly needed to compute the route.

### 6.3 Rendering and tracking pipeline

1. Camera display uses the best rear stream up to 1280×720.
2. Visual tracking consumes a downsampled 480×270 grayscale frame at a target of 12–15 frames per second.
3. Road features are selected only from the calibrated lower-screen region of interest.
4. Lucas–Kanade optical flow tracks features between frames.
5. RANSAC rejects outliers and estimates a road-plane homography.
6. Device orientation supplies responsive rotation; a complementary filter smooths sensor noise.
7. GPS is map-matched to the nearest plausible point on the route and updates global progress.
8. Visual motion corrects short-term screen attachment between slower GPS updates.
9. Three.js renders at the display refresh rate when possible, with a minimum target of 24 frames per second on supported devices.

Visual tracking runs in a Web Worker when `OffscreenCanvas` and transferable frames are available. The fallback runs a throttled tracker on the main thread without changing the public tracker interface.

## 7. Core Data Contracts

```ts
type GeoPoint = { lat: number; lng: number; altitudeMeters?: number };

type RouteStep = {
  instruction: string;
  maneuver: string;
  distanceMeters: number;
  polyline: string;
};

type RoutePlan = {
  origin: GeoPoint;
  destination: GeoPoint & { name: string };
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  steps: RouteStep[];
};

type LocalRoutePoint = {
  eastMeters: number;
  northMeters: number;
  upMeters: number;
  routeDistanceMeters: number;
};

type TrackingQuality = {
  state: "locked" | "weak" | "realign";
  featureCount: number;
  inlierCount: number;
  inlierRatio: number;
  medianReprojectionErrorPx: number;
};

type PoseEstimate = {
  positionMeters: [number, number, number];
  orientationQuaternion: [number, number, number, number];
  quality: TrackingQuality;
  timestampMs: number;
};
```

## 8. Failure Handling

- **Unsupported browser:** explain the minimum browser and device requirements before requesting permissions.
- **Insecure origin:** block AR startup and explain that HTTPS is required.
- **Location denied:** keep destination search available but disable route calculation and provide browser-specific recovery steps.
- **Camera denied or unavailable:** return to route preview and provide recovery steps.
- **Motion permission denied:** do not start AR; offer a retry initiated by a new button tap.
- **GPS accuracy worse than 25 metres:** show **Improving location accuracy** with a cancel option. Do not place road markers.
- **Places or Routes failure:** preserve the destination, show a retry action, and avoid duplicate automatic requests.
- **Network loss after route load:** continue the current route using the session copy. Recalculation remains unavailable until connectivity returns.
- **WebGL or OpenCV initialization failure:** return to route preview with a compatibility message rather than using an unstable sensor-only AR fallback.
- **Page backgrounded:** pause camera, tracking, sensors, and rendering. Resume through a brief confidence check; request re-alignment if the transform is stale.
- **Thermal or performance pressure:** reduce visual-tracking frequency before lowering rendering responsiveness. If rendering remains below 20 frames per second for five seconds, prompt the user to end or continue with fewer visible bars.

## 9. Privacy and Security

- Camera frames, grayscale tracking frames, features, and homographies remain in browser memory.
- No camera recording, screenshots, analytics, accounts, or user-location history are stored.
- Route/session data is cleared from `sessionStorage` when the user ends navigation.
- The server validates coordinates and place identifiers and applies same-origin CORS.
- Browser and server Google keys are separate and restricted to the minimum APIs.
- Cloud Console daily quotas are set below the applicable India monthly free-usage cap. Initial limits are 500 Routes requests per day, 2,000 Places autocomplete requests per day, and 1,000 Dynamic Maps loads per day. These limits are reduced if the billing account receives a smaller regional free cap.
- A Content Security Policy permits only the app origin and required Google Maps resources.

## 10. Performance Targets

- Search suggestions visible within two seconds on a typical 4G connection.
- Route preview visible within five seconds after destination selection.
- Calibration completed within ten seconds on a suitable road.
- Three.js rendering at 24 frames per second or better on the supported device floor.
- OpenCV tracking at 10 frames per second or better, targeting 12–15.
- The AR session becomes interactive within three seconds after camera permission is granted, excluding user calibration time.
- A 20-minute walking session completes without an unhandled error or browser memory exhaustion.

## 11. Verification Strategy

### 11.1 Unit tests

- Polyline decoding and 2.5-metre route resampling.
- Latitude/longitude to local East-North-Up conversion.
- Bearing, route progress, nearest-segment matching, arrival, and off-route decisions.
- Orientation normalization and complementary-filter behavior.
- Tracking-quality threshold transitions, including hysteresis across consecutive frames.
- Navigation state-machine transitions and session cleanup.
- Route endpoint schema validation and Google response mapping.

### 11.2 Deterministic visual-tracking tests

Versioned video fixtures will cover textured asphalt, concrete, shadows, slow pan, phone rotation, forward walking, feature loss, and recovery. Tests will verify:

- At least 15 RANSAC inliers during the valid portion of each suitable fixture.
- Median reprojection error of 3 pixels or less during locked tracking.
- Transition to **Re-align** within one second of deliberate feature loss.
- No NaN, infinite, or singular homography reaches pose fusion or rendering.

### 11.3 Browser integration tests

Playwright tests with mocked camera, geolocation, orientation, and API responses will verify search-to-arrival flow, every permission denial path, offline behavior after route load, session restoration, manual re-alignment, and route recalculation confirmation.

### 11.4 Physical-device acceptance tests

Test at minimum one supported iPhone in Safari and one supported Android phone in Chrome on three outdoor routes: straight, one 90-degree turn, and a curved path. The MVP passes when:

- Calibration succeeds within ten seconds on at least four of five attempts per route under suitable conditions.
- During a stationary five-second pan of approximately ±30 degrees, the nearest marker returns to within 40 screen pixels of its original road feature at 720p.
- At least 80 percent of visible route bars remain inside the intended road or footpath boundary during each test walk after calibration.
- Tracking loss removes the overlay and requests re-alignment within one second.
- No camera-frame request appears in captured network traffic.
- Route progress, turn instruction, manual recalculation, arrival, and end-session cleanup work on both platforms.

## 12. Delivery and Operations

- Deploy the Vite app and serverless route endpoint to Vercel over HTTPS for the MVP.
- Keep secrets in Vercel environment variables; commit only `.env.example` with variable names.
- Use separate Google Cloud projects or keys for local development and production.
- Configure allowed web origins before public testing.
- Configure Google API quotas before sharing the public URL.
- Log only anonymous endpoint status, latency, and error category. Do not log coordinates, place names, route polylines, or user-agent fingerprints.

## 13. MVP Milestones

1. **Route foundation:** destination search, location, walking route endpoint, route preview, and route-geometry tests.
2. **Camera and calibration:** permissions, camera lifecycle, placement guide, OpenCV feature collection, and confidence states.
3. **Road-locked rendering:** pose fusion, homography stabilization, sampled route bars, maneuver cues, and re-alignment.
4. **Walking lifecycle:** progress matching, deviation confirmation, arrival, session recovery, privacy cleanup, and failure handling.
5. **Device hardening:** performance tuning, deterministic fixtures, physical-device acceptance, HTTPS deployment, API restrictions, and quotas.

## 14. Feasibility Notes and References

- Google Routes can return route, leg, and step polylines suitable for sampling into local markers: [Google Routes polyline documentation](https://developers.google.com/maps/documentation/routes/traffic_on_polylines).
- Google Maps Platform uses pay-as-you-go billing with per-SKU free-usage caps and still requires billing to be enabled: [Google Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing) and [Routes usage and billing](https://developers.google.com/maps/documentation/routes/usage-and-billing).
- AR.js documents the GPS, compass, and shaking limitations that make a sensor-only solution insufficient for road locking: [AR.js location-based documentation](https://ar-js-org.github.io/AR.js-Docs/location-based/).
- OpenCV.js provides browser-side Lucas–Kanade optical flow used by the visual tracker: [OpenCV.js optical-flow documentation](https://docs.opencv.org/4.13.0/db/d7f/tutorial_js_lucas_kanade.html).
- Phone-based WebXR is not officially supported on iOS, so the cross-browser MVP cannot depend on `immersive-ar`: [WebKit issue comment](https://bugs.webkit.org/show_bug.cgi?id=309550).
