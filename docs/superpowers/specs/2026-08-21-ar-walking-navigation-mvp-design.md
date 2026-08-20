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

The MVP uses a sensor-assisted two-point ground calibration. Metric scale is not inferred from OpenCV. It comes from an approximate pinhole camera model and a user-confirmed camera height; the two taps establish the visible road direction and route offset.

This is option A—gravity/orientation, approximate camera intrinsics, estimated camera height, and a tapped ground origin—extended with a second direction tap. It requires one height choice, two taps, and a short feature scan, keeping implementation moderate and calibration within the ten-second target on suitable roads. Its metric accuracy is intentionally approximate and is sensitive to incorrect camera height, effective field of view, pitch noise, and non-flat roads; the visual lock is expected to be better than the absolute metre spacing. Arbitrary multi-point taps were rejected because points without known physical distances still do not reveal scale, while known-distance markers or pacing would add too much setup friction. Printed fiducials were rejected because they require an external object and change the intended point-and-walk experience.

1. The camera opens with a translucent placement guide in the lower half of the screen. The app reads the delivered video dimensions and builds an initial camera matrix with a centered principal point, square pixels, and an initial experimental effective horizontal field of view of 65 degrees. The browser does not expose the real focal length or field of view.
2. The user selects the approximate height of the phone camera above the road: **Low — 1.2 m**, **Chest — 1.4 m**, or **Eye — 1.6 m**. **Chest** is the default. The user is instructed to keep the phone near that height while navigating.
3. While the user stands still, gravity and device orientation establish the ground normal, camera roll, and camera pitch. Compass heading supplies an initial yaw prior. The calibrated ground frame has its origin at the vertical projection of the camera onto the assumed horizontal road plane, its y-axis up, and its z-axis along the gravity-level camera-forward direction at calibration.
4. The user points down the first route segment and taps a **near** point on the intended path centre, normally two to five metres ahead. The app converts the image pixel into a camera ray and intersects it with the ground plane using the camera matrix, orientation, and selected camera height.
5. The user taps a **far** point on the same path centre. Its ground intersection and the near intersection define the visible road direction. The far point is used for direction only; its real-world distance is not assumed to be known.
6. The route matcher chooses the current route progress and tangent from GPS. A rigid horizontal transform maps the route-local forward axis onto the tapped road direction and maps the corresponding near route point onto the near ground intersection. This determines yaw correction and lateral/longitudinal offset without allowing vision to change metric scale.
7. The user moves the phone slowly left and right for three to five seconds while remaining in place. OpenCV.js collects road features and creates the first visual keyframe for post-lock stabilization.
8. The guide changes from translucent to green when both ray-plane intersections are valid, the far point is at least two estimated ground metres beyond the near point, and tracking meets its initial experimental quality defaults of 30 candidate features and 15 homography inliers.
9. The user taps **Lock route**. The camera model, selected height, route-to-ground transform, camera-to-ground pose, and visual keyframe become one immutable calibration snapshot for the active lock.

Calibration is rejected when a tap ray is parallel to or above the ground plane, the two taps do not form a stable forward direction, or the road lacks enough features. The app asks the user to adjust the taps, aim at a more textured patch, or choose a more accurate camera-height preset. Changing camera stream dimensions, changing screen orientation, restarting the camera, or substantially changing how high the phone is held requires re-alignment.

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

The numeric thresholds below are initial experimental defaults to be tuned with fixture and device testing; they are not geometric or architectural constants.

- **Weak:** fewer than 15 homography inliers, an inlier ratio below 0.55, or median reprojection error above 3 pixels for five consecutive processed frames. The overlay opacity falls to 50 percent while tracking attempts to recover.
- **Re-align:** fewer than 10 inliers or invalid motion for ten consecutive processed frames. The overlay disappears and the calibration guide returns while the route remains loaded.
- **Off route:** the map-matched location is more than 20 metres from the route for three consecutive GPS readings whose reported accuracy is 15 metres or better. The user is offered **Recalculate route** or **Keep current route**.

## 6. System Architecture

### 6.1 Browser application

The application is a Vite and TypeScript single-page web app with a small PWA manifest for full-screen mobile presentation. It is divided by responsibility:

- **Search controller:** Google Places autocomplete, selected place, and search errors.
- **Route client:** calls the server route endpoint and validates the returned route plan.
- **Route geometry:** decodes the polyline, converts latitude/longitude to a local East-North-Up frame, samples route points, calculates bearings, and map-matches user progress.
- **Calibration geometry:** constructs approximate camera intrinsics, normalizes image-to-screen crop and rotation, intersects camera rays with the assumed ground plane, fits the two-tap route-to-ground transform, and owns the immutable calibration snapshot.
- **Permission controller:** camera, location, and iOS motion/orientation permission state.
- **Camera controller:** rear-camera stream lifecycle, resolution selection, and video-frame scheduling.
- **Visual tracker:** OpenCV.js feature detection, Lucas–Kanade optical flow, RANSAC homography, and tracking confidence.
- **Sensor adapter:** normalized location, compass, device orientation, and device motion events across Safari and Chrome.
- **Pose fusion:** produces a nominal metric camera pose from orientation and smoothed GPS progress, then combines it with a bounded visual residual without snapping the overlay.
- **AR renderer:** Three.js scene, ground-plane arrow geometry, explicit coordinate-frame transforms, perspective projection, image-to-screen mapping, and frame rendering.
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

The geometry uses five explicit coordinate frames:

- **World / ENU frame E:** a local metric East-North-Up frame whose origin is the map-matched calibration position. Google route points are converted from latitude/longitude into this frame.
- **Route-local frame R:** origin at calibration route progress, x to the route's right, y up, and z along the route tangent. Curved route points retain their ENU geometry and are rotated into this frame.
- **Calibrated ground frame G:** origin at the ground point vertically below the calibration camera, y up, and z along gravity-level camera-forward at lock. The two-tap calibration defines the rigid horizontal transform from R to G.
- **Camera frame C:** x right, y down, and z forward from the rear camera.
- **Image and screen frames I/S:** I uses delivered video pixels with the origin at top left; S uses CSS pixels after portrait rotation and `object-fit: cover` cropping.

For a route point, the projection order is fixed:

1. Convert latitude/longitude to an ENU metric point `p_E`.
2. Convert into route-local coordinates: `p_R = R_R_E × (p_E - routeOrigin_E)`.
3. Apply the locked horizontal calibration: `p_G = R_G_R × p_R + t_G_R`.
4. Apply the current nominal camera pose: `p_C = R_C_G × (p_G - cameraPosition_G)`.
5. Perspective-project through the camera matrix: `p_I ~ K × p_C`, rejecting points with non-positive camera z.
6. Apply the bounded visual residual homography in image space, then the image-to-screen crop/rotation: `p_S ~ A_S_I × H_visual × p_I`.

The complete conceptual transform is therefore `p_S ~ A_S_I H_visual K T_C_G T_G_R T_R_E p_E`. Matrices use one documented column-vector convention throughout the implementation.

The initial camera matrix uses the delivered video width and height. With the initial experimental effective horizontal field of view `fovX = 65°`, `fx = width / (2 tan(fovX / 2))`, `fy = fx`, `cx = width / 2`, and `cy = height / 2`. The selected camera height supplies the plane distance that makes ray-ground intersections metric. This is deliberately approximate: height and effective-FOV error produce scale error, so acceptance testing measures and documents the usable range rather than claiming native-AR accuracy.

Let `gNear` and `gFar` be the two ray-ground intersections in G. The tapped road direction is `v = normalizeXZ(gFar - gNear)`. Let `dNear = max(0, dotXZ(gNear, v))`, and let `rNear` be the actual route-local point sampled at route distance `calibrationProgress + dNear`. `R_G_R` is the yaw-only rotation that maps the route tangent at calibration onto `v`; translation is then `t_G_R = gNear - R_G_R × rNear`. This maps a concrete metric route point onto the near tap while preserving the scale established by the camera model and height.

During navigation:

1. Camera display uses the best rear stream up to 1280×720.
2. Visual tracking consumes a downsampled 480×270 grayscale frame at a target of 12–15 frames per second.
3. Device orientation and gyroscope integration control fast rotational response of the nominal camera pose. Gravity controls ground normal; compass supplies a slowly corrected global yaw prior.
4. GPS is map-matched to the nearest plausible route point and supplies the target route progress. Displayed progress follows it with a 1.5-second critically damped filter and a plausible walking-speed bound, so a GPS jump does not move all bars in one frame.
5. Route progress changes which sampled bars are behind or ahead and slowly advances nominal camera translation. It does not alter the locked route-to-ground scale or orientation.
6. Road features are tracked with Lucas–Kanade optical flow. RANSAC estimates an observed frame-to-frame road homography.
7. The tracker removes the image motion predicted by the orientation delta, `H_sensor ≈ K ΔR K⁻¹`, and filters the remaining `H_visual = H_observed H_sensor⁻¹` as a local image-space correction. This avoids counting the same phone rotation in both sensors and vision.
8. The visual residual keeps projected ground vertices attached to the visible road patch. It may correct short-term planar translation, rotation, and projective error, but it must not change the camera-height estimate, camera intrinsics, route progress, or metric route-to-ground transform.
9. Compass and GPS correct long-term global drift slowly. Small sensor/vision disagreement is blended over multiple frames. Sustained disagreement beyond experimental angular, translation, or reprojection limits changes tracking to **Weak**; large or geometrically invalid disagreement triggers **Re-align** instead of forcing either estimate.
10. A new visual keyframe may be created while quality is locked, but keyframe replacement must preserve the current accumulated image correction. Homography composition is bounded and normalized to prevent numerical growth.
11. Three.js renders at the display refresh rate when possible, with a minimum target of 24 frames per second on supported devices.

Visual tracking runs in a Web Worker when `OffscreenCanvas` and transferable frames are available. The fallback runs a throttled tracker on the main thread without changing the public tracker interface. All feature, inlier, reprojection, and disagreement thresholds are initial experimental defaults maintained as configuration values and tuned through device testing.

## 7. Core Data Contracts

```ts
type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number
];

type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

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

type RouteGroundPoint = {
  rightMeters: number;
  upMeters: number;
  forwardMeters: number;
  routeDistanceMeters: number;
};

type CameraIntrinsics = {
  imageWidthPx: number;
  imageHeightPx: number;
  fxPx: number;
  fyPx: number;
  cxPx: number;
  cyPx: number;
  effectiveHorizontalFovDeg: number;
  source: "assumed-fov";
};

type CalibrationStage =
  | "select-height"
  | "capture-orientation"
  | "tap-near"
  | "tap-far"
  | "scan-features"
  | "ready"
  | "locked"
  | "failed";

type GroundCalibration = {
  stage: CalibrationStage;
  cameraHeightMeters: 1.2 | 1.4 | 1.6;
  intrinsics: CameraIntrinsics;
  imageToScreen: Mat3;
  groundFromRoute: Mat4;
  cameraFromGroundAtLock: Mat4;
  calibrationRouteDistanceMeters: number;
  lockedAtMs?: number;
};

type TrackingQuality = {
  state: "locked" | "weak" | "realign";
  featureCount: number;
  inlierCount: number;
  inlierRatio: number;
  medianReprojectionErrorPx: number;
};

type VisualCorrection = {
  imageHomography: Mat3;
  keyframeId: number;
  timestampMs: number;
};

type PoseEstimate = {
  cameraPositionGroundMeters: [number, number, number];
  orientationQuaternion: [number, number, number, number];
  cameraFromGround: Mat4;
  visualCorrection: VisualCorrection;
  displayedRouteProgressMeters: number;
  quality: TrackingQuality;
  timestampMs: number;
};
```

### Geometry invariants

- GPS and map matching own global route selection and route progress; OpenCV never advances, bends, rescales, or reroutes the path.
- Camera height and camera intrinsics establish approximate metric scale at lock. A visual homography may stabilize the image projection but may not redefine that scale.
- The transform order is always ENU → route-local → calibrated ground → camera → image → screen. No module may skip a frame by mixing metres, video pixels, and CSS pixels.
- `imageToScreen` is applied last and is rebuilt whenever stream dimensions, device orientation, or cover-crop geometry changes. Such a change invalidates the active visual keyframe.
- The route-to-ground transform remains immutable for one lock. Corrections beyond its safe visual residual require explicit re-alignment.
- Invalid, behind-camera, singular, or low-confidence projections are not rendered.
- Camera frames, raw image points, and visual features remain on device and are not persisted.

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
- Height selection, two-point ground calibration, and feature scan completed within ten seconds on a suitable road after permissions are granted.
- Three.js rendering at 24 frames per second or better on the supported device floor.
- OpenCV tracking at 10 frames per second or better, targeting 12–15.
- The AR session becomes interactive within three seconds after camera permission is granted, excluding user calibration time.
- A 20-minute walking session completes without an unhandled error or browser memory exhaustion.

## 11. Verification Strategy

### 11.1 Unit tests

- Polyline decoding and 2.5-metre route resampling.
- Latitude/longitude to local East-North-Up conversion.
- Camera-matrix construction from video dimensions and effective field of view.
- Image-to-screen rotation and `object-fit: cover` crop mapping in portrait and landscape source dimensions.
- Image-pixel ray construction and valid/invalid ray-ground intersections for each height preset.
- ENU → route-local → ground → camera → image → screen transform composition against synthetic fixtures.
- Two-tap route-to-ground fitting, including near/far ordering, route yaw correction, and lateral offset.
- Sensitivity tests showing the expected projection change when camera height or effective field of view changes.
- Bearing, route progress, nearest-segment matching, arrival, and off-route decisions.
- Orientation normalization, sensor-predicted image homography, and complementary-filter behavior.
- Route-progress smoothing that prevents single-frame jumps while converging on a valid GPS target.
- Tracking-quality threshold transitions, including hysteresis across consecutive frames.
- Geometry-invariant tests proving that visual correction cannot mutate metric calibration or route progress.
- Navigation state-machine transitions and session cleanup.
- Route endpoint schema validation and Google response mapping.

### 11.2 Deterministic visual-tracking tests

Versioned video fixtures will cover textured asphalt, concrete, shadows, slow pan, phone rotation, forward walking, feature loss, and recovery. Tests will verify:

- The sensor-predicted rotation is removed before applying the residual visual homography, avoiding double rotation.
- Visual keyframe replacement preserves the current projected road attachment.
- Initial experimental defaults of at least 15 RANSAC inliers and median reprojection error of 3 pixels or less during the valid portion of suitable fixtures.
- Transition to **Re-align** within one second of deliberate feature loss.
- No NaN, infinite, or singular homography reaches pose fusion or rendering.

### 11.3 Browser integration tests

Playwright tests with mocked camera, geolocation, orientation, and API responses will verify search-to-arrival flow, every permission denial path, offline behavior after route load, session restoration, manual re-alignment, and route recalculation confirmation.

Calibration integration coverage includes all three height presets, invalid near/far taps, an orientation change that invalidates calibration, a stream-dimension change that rebuilds image-to-screen mapping, and a simulated GPS progress jump that is visually eased.

### 11.4 Physical-device acceptance tests

Test at minimum one supported iPhone in Safari and one supported Android phone in Chrome on three outdoor routes: straight, one 90-degree turn, and a curved path. The MVP passes when:

- Calibration succeeds within ten seconds on at least four of five attempts per route under suitable conditions.
- On a measured flat test path and the closest height preset, projected contacts for the first ten route metres have no more than 25 percent longitudinal scale error and 0.75 metre lateral error. These are MVP acceptance bounds, not guarantees for unmeasured roads.
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
2. **Camera and metric calibration:** permissions, camera lifecycle, approximate camera matrix, height presets, orientation capture, two-point ground fitting, image-to-screen mapping, OpenCV keyframe collection, and confidence states.
3. **Road-locked rendering:** explicit frame transforms, nominal sensor pose, residual homography stabilization, smoothed GPS progress, sampled route bars, maneuver cues, and re-alignment.
4. **Walking lifecycle:** progress matching, deviation confirmation, arrival, session recovery, privacy cleanup, and failure handling.
5. **Device hardening:** performance tuning, deterministic fixtures, physical-device acceptance, HTTPS deployment, API restrictions, and quotas.

## 14. Feasibility Notes and References

- Google Routes can return route, leg, and step polylines suitable for sampling into local markers: [Google Routes polyline documentation](https://developers.google.com/maps/documentation/routes/traffic_on_polylines).
- Google Maps Platform uses pay-as-you-go billing with per-SKU free-usage caps and still requires billing to be enabled: [Google Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing) and [Routes usage and billing](https://developers.google.com/maps/documentation/routes/usage-and-billing).
- AR.js documents the GPS, compass, and shaking limitations that make a sensor-only solution insufficient for road locking: [AR.js location-based documentation](https://ar-js-org.github.io/AR.js-Docs/location-based/).
- OpenCV.js provides browser-side Lucas–Kanade optical flow used by the visual tracker: [OpenCV.js optical-flow documentation](https://docs.opencv.org/4.13.0/db/d7f/tutorial_js_lucas_kanade.html).
- The Media Capture specification exposes video dimensions and facing mode but no focal length or field-of-view setting, which is why the MVP labels its camera matrix as approximate: [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/).
- Device orientation supplies gravity-relative and, when available, Earth-relative orientation priors rather than a full metric camera pose: [W3C Device Orientation and Motion](https://www.w3.org/TR/orientation-event/).
- Phone-based WebXR is not officially supported on iOS, so the cross-browser MVP cannot depend on `immersive-ar`: [WebKit issue comment](https://bugs.webkit.org/show_bug.cgi?id=309550).
