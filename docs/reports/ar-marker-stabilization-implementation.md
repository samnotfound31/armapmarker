# AR route marker stabilization — implementation record

Baseline: `616a048344afc9a4537935d7849955c3168efe7e` on `codex/ar-navigation-mvp`.

## Scope and authority

This change addresses display registration during walking. Provider endpoints, search,
API handlers, accepted-location rules, route matching, wrong-way/deviation logic,
route geometry, and maneuver progress remain authoritative and unchanged.
Render position, visual registration, and manual alignment cannot write back into
those quantities. Geographic invalidity always suppresses the overlay.

## Root causes addressed

1. Markers were sampled relative to moving progress, which moved an existing pattern.
2. Visual confidence was sensitive to individual results and did not handle silence.
3. A worker could change its reference before the main thread rejected a result.
4. Bitmap completion and React delivery could associate an image with a later pose.
5. Orientation observations drove rendering without angular-rate prediction.
6. Sensor-only homography subtraction could count nominal translation twice.
7. Image-space corrections could be applied unchanged to a different camera pose.
8. Correction confidence/age could animate registration back toward identity.
9. A pseudo-keyframe refresh did not retain and directly validate a real image.
10. Small clusters could have a misleadingly high inlier ratio.
11. Tracker failure could tear down camera/HUD rather than attempt reacquisition.
12. User alignment required a session restart and lacked an explicit persistent lock.
13. Gyro events could shrink the observation correction interval and make filter bandwidth depend on callback ordering.
14. The initial ghost and Lock used a periodically polled attitude instead of the currently displayed camera frame.

## Phase 1: persistent geometry and measurement ownership

`routeRibbon.ts` uses a fixed route-distance lattice: the ID is derived from the
lattice index, not progress. Shared IDs retain identical vertices and parity.
Progress changes the visible window. The renderer keeps a padded window and uses
per-marker near/horizon opacity fades; it never moves vertices to fade them.
Marker identity diagnostics count retained and unexpectedly changed anchors.

`TrackingQualityGate` owns elapsed-time transitions. Starting values are five
strong observations spanning at least 300 ms to acquire LOCKED, two consistent
observations to enter RECOVERING, 250 ms without a strong observation for WEAK,
and 1,800 ms for REALIGN. A rejected frame resets a strong streak but does not
replace the last accepted correction. A watchdog handles silence.

The worker stages image measurements. Main-thread acceptance acknowledges the
specific timestamp before retention or promotion. Stale results get a negative
acknowledgement and cannot mutate trusted registration or reference images.

## Phase 2: frame timeline and presentation estimators

### Camera timeline

The frame source uses the same visible video element as the renderer. It prefers
`requestVideoFrameCallback`, falls back to new `video.currentTime` frames on RAF,
and freezes nominal pose before asynchronous bitmap creation. Metadata includes
frame ID, camera generation, image/display time, timestamp source, dimensions,
orientation, and nominal pose revision. A dimension/orientation/source change
creates a new generation. Pose/frame histories cover approximately two seconds.

Local Safari does not necessarily expose camera exposure time. The presentation
fallback is explicitly labeled and its available offset is reported; this is not
a claim of exposure-perfect synchronization.

### Attitude

`AttitudeEstimator` uses a quaternion complementary estimator. Device-motion rates
predict genuine rotation; orientation innovations correct tilt over an initial
200 ms time constant and yaw over 2,000 ms. Propagation and orientation-observation
clocks are separate, correction gaps are capped at 100 ms, and same-time history
entries retain the newest revision. Render extrapolation is limited to
30 ms / 0.05 radians. Unsupported large compass observations are quarantined;
sustained discrepancies are corrected gradually. Without usable angular rate,
an adaptive quaternion observation filter provides a lower-confidence fallback.
There is no independent Euler-axis filtering or whole-camera low-pass filter.
The existing reflected geographic frame is converted to a proper quaternion and
restored on output, preserving the existing ENU convention.

### Position and RenderPose

`RenderPositionEstimator` consumes accepted actual GPS only. Accuracy controls
observation weight; velocity is bounded at 2.5 m/s, display prediction at 1 s / 1 m.
Corrections larger than 3 m adopt the new position and require visual recovery,
rather than creating a long slide. It never snaps to route progress and does not
integrate accelerometer position or estimate height.

`RenderPoseController` owns nominal pose history, frame/reference ownership,
visual validation, transport, confidence, opacity, and manual registration.
The animation loop samples the displayed image's frozen nominal pose directly.
React receives HUD/debug updates around 4–5 Hz. New image dimensions rescale the
assumed intrinsics and invalidate old registrations.

### Full nominal residual and transport

All matrices use column vectors. `N` maps geographic ground `[east,north,1]` to
raw image pixels and contains the same attitude, render position and intrinsics
as the renderer. `O` maps retained keyframe pixels to current pixels. Manual
registration is separate from `N` and never enters geographic truth.

```
C_t = O_(t<-k) C_k N_k inverse(N_t)
P_(r<-t) = N_r inverse(N_t)
C_r = P_(r<-t) C_t N_t inverse(N_r)
```

This removes nominal ground-plane translation and rotation exactly once. The
transport preserves the accepted ground registration as the camera changes.
Tests compare projected points because homographies are equivalent up to scale.
Confidence controls opacity, never geometry decay toward identity.

## Phase 3: actual image references and visual validation

OpenCV retains an equal-sized real grayscale image and ground-selected features.
Reverse LK is initialized at the original feature to avoid repeated-texture aliasing;
the forward/backward error threshold remains unchanged.
Only detection uses the moving ground ROI; LK uses the full unchanged image size,
without a synthetic mask boundary. Sharpness is measured within the ground ROI. Adjacent accepted-frame
flow initializes a direct LK/RANSAC check against the retained keyframe. A rejected
intermediate image never becomes the next accepted adjacent reference.

Promotion becomes eligible after 800 ms with sharpness, overlap, inlier support,
residual quality, and main-thread registration agreement. An expired reference
(after 2 s) can seed reacquisition while preserving the accepted correction;
strong evidence is still required for LOCKED. Only accepted acknowledgement
changes reference ownership. At most a keyframe, last accepted adjacent image,
and one pending candidate are retained. Bitmap and CV allocations are released
on rejection, promotion, shutdown, or late asynchronous completion.

Validation includes original/surviving features, inlier ratio/count, forward/backward
consistency, 3-by-4 ground support cells, non-collinearity, median/p90 residuals,
symmetric transfer error, projective plausibility, nominal-motion agreement,
pixel innovation, and a 2 m combined manual/visual ground-registration budget.
Oversized or malformed measurements are rejected, never clamped into trust.
Ground ROI placement follows the predicted horizon. This is a planar robust-fit
model; it is not semantic detection of people, walls, or moving objects.

Processing is one frame in flight at an initial 80 ms capture cadence (100 ms
fallback cadence). A 1 s processing watchdog releases a silent worker. Session
restarts use bounded exponential backoff up to 30 s; camera/HUD remain active.

## Phase 4: confirmed alignment

The calibration ghost uses a persistent RenderPoseController with the same live
sensor/motion axes, visible-video frame timeline, and projection functions as guidance.
The ghost timeline skips bitmap creation entirely. Lock is unavailable until a current
valid frame is present; confirmation freezes that frame pose, dimensions and manual
trim. Legacy injected feeds recapture at Lock. The initial 700 ms polling path no
longer drives the production ghost.
Controls allow lateral shift of ±1 m and yaw trim of ±3° (hard API maximum ±5°).
There is no scale, pitch, roll, forward-shift, or height control. Lock carries the
manual registration into the session. Adjust alignment opens the same controls
without restarting the camera or changing route progress. Reset clears only
manual registration. Lock requires another sustained visual acquisition window.

Manual alignment is a separate fixed transform and is retained through rejected
frames and promotion. Visual correction remains bounded around that registration.
A large combined disagreement suppresses guidance and requests recovery; it
cannot silently erase the user's confirmed trim. A yaw trim pivots at the fixed
calibration route origin: its displacement grows farther along the route and
may exhaust the 2 m budget. Use the smallest necessary trim; do not recenter the
route as the user walks.

## Safe telemetry

With `?arDebug=1`, the panel updates approximately four times per second. It shows
observed/estimated angle diagnostics, rate magnitude, innovation, sensor age,
prediction duration, features/tracks/inliers/coverage/residuals, correction magnitude,
keyframe age, rejected/stale/dropped counts, bitmap/processing/result timing,
available image/pose offset, render angular/position deltas, opacity, marker
continuity, manual trim, and registration budget. It never records frames,
raw latitude/longitude, secrets, or device identifiers. Diagnostic Euler angles
are display summaries of quaternion estimates, not estimator state.

## Automated evidence and physical limits

The deterministic cases cover yaw noise and projected-marker variance, real
multi-axis motion, 30°/90° turns, north wrap, isolated/repeated outliers, recovery,
accepted A-to-C frame ownership, stale generations/references, nominal translation
and vertical bob, fixed marker vertices, weak persistence, geographic isolation,
delayed bitmap/display timing, correction transport, promotion continuity,
cluster/collinearity rejection, format changes, resource cleanup, and worker silence.
The shipped OpenCV runtime is exercised in Chromium and iPhone-style WebKit under
production CSP using textured planar sequences, real LK/RANSAC, keyframe changes,
vertical bob, forward motion, and temporary texture loss. The virtual texture is
unbounded so walking reveals fresh ground rather than exhausting one image.

These tests establish software invariants. They do not prove a physical iPhone
30 m acceptance run. Approximate FOV/height, exposure timestamp availability,
compass disturbance, motion blur, sparse texture, non-planar ground and phone CPU
latency still require field measurements. No custom metric-height or inertial
position estimation is claimed. Backgrounding retains the existing safe pause /
foreground resume flow.

## Exact iPhone field-test procedure

1. Open the delivered Preview in Safari; append `?arDebug=1` for safe diagnostics.
2. Choose a safe, approximately 30 m outdoor route with recognizable ground texture.
3. Search the destination and load the route. Confirm geographic guidance is valid.
4. Start AR, hold naturally with textured ground in view, and inspect the ghost.
5. Apply the smallest lateral/yaw trim needed, or leave both zero. Lock alignment.
6. Stand still for about 5 s. Check markers near 3, 5 and 10 m and sustained LOCKED.
7. Walk 30 m one-handed at normal pace; allow normal wrist bob.
8. Gently turn about 30° left/right while walking. Markers must follow camera motion
   and remain geographically placed; they must not be recentered in front.
9. Briefly shake once. A rejected image must not move the accepted registration.
10. Point away and back. Off-screen/behind-camera geometry is correct; allow
    automatic reacquisition when ground returns.
11. Cross a lower-texture patch. Confirm gradual WEAK/RECOVERING behavior and no
    unexplained geometry jump or immediate disappearance from one weak frame.
12. Stop, then resume. Verify progress and fixed marker anchors stay consistent.
13. Repeat the complete walk three times.

Record state, timing, correction delta, marker continuity and visible-marker count
when a problem occurs. Do not record coordinates, camera imagery or secrets.
A physical pass requires no unexplained large single-frame jump, responsive
intentional turns, automatic recovery and no routine realignment during valid-sensor
walks. A failing run is tuning/measurement evidence, not permission to relax
geographic gates or acceptance tests.

## Rollback

The stabilization change is isolated in one feature-branch commit. If field evidence
requires rollback, revert that commit on the same feature branch and allow the
normal Preview build. Do not reset/discard local work or change master. Each phase's
configuration is centralized for focused tuning without rewriting navigation.

## Implementation choices and their costs

- The PDF and execution request are used directly; an ignored progress ledger replaces
  Markdown task-script parsing. Cost if wrong: less automated task bookkeeping; verification
  commands and results remain recorded here.
- Legacy PoseFusion remains for geographic/HUD snapshots; active drawing samples
  RenderPoseController. Cost if wrong: HUD/display disagreement, covered by isolation tests.
- Missing exposure timestamps use a labeled presentation fallback. Cost if wrong:
  residual physical video/sensor latency; field measurements are required.
- The existing reflected geographic frame is converted to a proper quaternion and
  restored at the boundary. Cost if wrong: incorrect rotation; a reflected-frame test covers it.
- Synthetic road texture extends beyond the initial image and uses bilinear sampling.
  Cost if wrong: an overly favorable scene; synthetic success cannot establish physical acceptance.
- Browser hardware fixtures render images consistent with simulated GPS/heading.
  Cost if wrong: hardware conventions differ; physical validation remains required.
- Browser calibration helpers use explicit Lock alignment; one-tap anchoring remains
  covered in component tests. Padded-horizon tests retain projection/lateral assertions
  instead of a legacy exact center count. Cost if wrong: missed UI/projection regression;
  component, real renderer, and browser tests cover those boundaries.

## Test coverage map

| Required behavior | Main deterministic coverage |
| --- | --- |
| Noise, real motion, 30°/90° turns, north wrap | AttitudeEstimator tests |
| Actual accepted position, bounded prediction, correction recovery | RenderPositionEstimator tests |
| Full nominal translation/bob subtraction, delayed transport | groundRegistration tests |
| Outliers, stale frames, generation/reference ownership, geographic isolation | RenderPoseController tests |
| Fixed IDs/vertices, horizon fades, geographic suppression | routeRibbon / RouteRenderer tests |
| Weak persistence, elapsed loss/recovery, silence | quality / RenderPoseController tests |
| Accepted A→C after dropped B, keyframe resource ownership | OpenCvTracker / browserAdapters tests |
| Bitmap delay, displayed-frame pose, dimensions/orientation | CameraFrameTimeline / browserAdapters tests |
| Worker silence, negative acknowledgement, late initialization cleanup | TrackerClient tests |
| Manual trim persistence, Lock/Reset, no session teardown | CalibrationScreen / App integration tests |
| Real LK/RANSAC, retained references, promotion continuity, bob/loss recovery | OpenCV runtime browser tests in Chromium and WebKit |
| Heading, lateral displacement, geographic invalidity, lifecycle | Full browser suite in Chromium and iPhone-style WebKit |

## Files in this change

### Added

- `docs/reports/ar-marker-stabilization-implementation.md`
- `src/components/AlignmentControls.tsx`
- `src/pose/AttitudeEstimator.test.ts`
- `src/pose/AttitudeEstimator.ts`
- `src/pose/RenderPoseController.test.ts`
- `src/pose/RenderPoseController.ts`
- `src/pose/RenderPositionEstimator.test.ts`
- `src/pose/RenderPositionEstimator.ts`
- `src/pose/groundRegistration.test.ts`
- `src/pose/groundRegistration.ts`
- `src/pose/stabilizationConfig.ts`
- `src/session/CameraFrameTimeline.test.ts`
- `src/session/CameraFrameTimeline.ts`

### Modified

- `src/session/browserCalibration.ts`
- `e2e/fixtures/fakeMobile.ts`
- `e2e/fixtures/syntheticDevice.ts`
- `e2e/geographic-guidance.spec.ts`
- `e2e/opencv-runtime.spec.ts`
- `e2e/realOpenCvSmoke.ts`
- `e2e/release-flow.spec.ts`
- `src/app/App.integration.test.tsx`
- `src/app/App.tsx`
- `src/app/app.css`
- `src/ar/RouteRenderer.test.ts`
- `src/ar/RouteRenderer.ts`
- `src/ar/projection.ts`
- `src/ar/routeRibbon.test.ts`
- `src/ar/routeRibbon.ts`
- `src/components/ArViewport.tsx`
- `src/components/CalibrationScreen.test.tsx`
- `src/components/CalibrationScreen.tsx`
- `src/components/TrackingWarning.tsx`
- `src/domain/types.ts`
- `src/pose/PoseFusion.test.ts`
- `src/pose/PoseFusion.ts`
- `src/session/NavigationSession.test.ts`
- `src/session/NavigationSession.ts`
- `src/session/browserAdapters.test.ts`
- `src/session/browserAdapters.ts`
- `src/tracking/OpenCvTracker.test.ts`
- `src/tracking/OpenCvTracker.ts`
- `src/tracking/TrackerClient.test.ts`
- `src/tracking/TrackerClient.ts`
- `src/tracking/quality.test.ts`
- `src/tracking/quality.ts`
- `src/tracking/residualHomography.ts`
- `src/tracking/tracker.worker.ts`
- `src/tracking/types.ts`

Pre-existing `.gitignore`, the earlier plan/spec documents, and the report PDF
are preserved and excluded. No environment, dependency, provider, search, or
navigation-authority source file is included.

## Release verification

- `npm test`: 375/375 tests, 52 test files, exit 0.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0.
- `npm run build`: exit 0.
- `npm run e2e`: 34/34, 17 Chromium and 17 iPhone-style WebKit, exit 0.
- Eight of the browser cases exercise real shipped OpenCV under production CSP.

Build warnings: OpenCV is still a large deferred runtime (about 15.56 MB raw /
3.95 MB compressed, with worker and fallback assets). Vite reports large chunks
and browser externalization of OpenCV's Node-only fs/crypto branches. Actual browser
runtime tests pass; these warnings remain relevant to cold-start/download/CPU
tuning. Playwright also reports the harmless NO_COLOR/FORCE_COLOR environment warning.
No dependencies, API handlers, environment variables or deployment settings changed.

## Final review and bounded fix pass

The original fresh reviewer resumed after a usage-limit interruption and returned
two Important findings, no Critical findings and no deferred minors. Both were
reproduced before fixing: orientation correction varied with gyro event order,
and the initial ghost/Lock used an old capture. Focused regressions now cover
5/10/20 ms gyro rates, independent observation correction intervals, live ghost
response, frame-associated Lock continuity, manual trim retention, initial Lock
readiness, and fresh capture for legacy feeds. The focused boundary suite passes
27/27; full release counts above describe the final tree.

### Review scope decisions

- Provider/search/backend and independent geographic correctness: retain those
  unchanged systems and check gating/isolation/regression behavior. Cost if wrong:
  an unrelated pre-existing fault can remain outside this task.
- Physical exposure latency, compass quality, iPhone CPU and tuning constants:
  retain field acceptance as pending. Cost if wrong: the Preview may need further tuning.
- Semantic people/wall rejection: use bounded planar ROI/RANSAC and spatial/nominal
  validation. Cost if wrong: a coherent wrong plane may cause bounded local error
  or delayed rejection; no semantic classifier is claimed.
- Background/foreground policy: preserve safe pause/resume and cleanup. Cost if
  wrong: resuming can require user alignment; uninterrupted registration is not promised.

Deferred minors: none.
