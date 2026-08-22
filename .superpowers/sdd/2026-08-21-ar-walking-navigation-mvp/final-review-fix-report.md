# Final review fix report: production AR correctness

**Date:** 2026-08-22

**Branch:** `codex/ar-navigation-mvp`

**Reviewed base:** `34539c6e9c8d9b38b8331b6af6d6874849dd87b8`

## Outcome

All five Critical and eight Important findings in `final-review-fix-brief.md` are addressed in one coordinated fix wave. The browser-only MVP scope, GPS-authoritative route progress, fixed metric ground frame, on-device visual tracking, and pending physical-device status are preserved.

## Changes by finding

1. **iPhone permission activation**
   - Camera and motion permission calls now both occur synchronously from the Enable-button call stack before the first `await`.
   - Promise and synchronous motion failures are retained and camera streams are stopped after any later failure.

2. **Route tangent to tapped-road direction**
   - Added `prepareRoute`, which matches the exact calibration point, creates an explicit route-local frame from the matched segment tangent, and converts the full curved route through `createRouteFrame`/`toRouteLocal`.
   - Eastbound, westbound, northbound, curved, and offset-origin cases are covered.

3. **Calibration/progress translation**
   - Calibration projects the near tap onto the tapped road direction, samples the concrete route point at `calibrationProgress + dNear`, and fits that point to the near tap.
   - The exact calibration progress is stored independently. Live camera translation is expressed relative to its exact calibrated ground point, preserving `[0, height, 0]` on the first fix.
   - Navigation progress filters initialize at the calibration match, including nonzero re-alignment.

4. **Visual residual correctness**
   - Added frame-time `K ΔR K^-1` sensor homographies from consecutive camera orientations.
   - ROI/resized homographies are conjugated into full-image coordinates before sensor subtraction.
   - Frame residuals are normalized and accumulated against a logical retained keyframe. Ordinary frames retain the keyframe ID; deliberate replacement increments it while preserving accumulated correction.
   - OpenCV remains dynamically imported. Frame/estimate allocations are released on success, tracking loss, and residual errors.

5. **Quality-dependent route visibility**
   - Renderer view state now carries overlay opacity: locked `1`, weak `0.5`, realign `0`; locked recovery restores full visibility.
   - Lost tracker quality is propagated immediately into the rendered pose.

6. **One ENU origin**
   - Route decoding, calibration matching, and every live GPS conversion use the same explicit route origin, including a polyline whose first snapped point differs from the requested origin.

7. **Correct re-alignment source/progress**
   - The app retains the latest accepted fix and snapped progress.
   - Every re-alignment re-prepares the route from that fix and starts calibration/session filters at the matched nonzero progress.

8. **Real route recalculation**
   - Recalculate stops active AR resources, obtains a fresh high-accuracy fix, requests a new walking route for the existing destination, and replaces route/session state.
   - Failure retains the current route preview and reports the error. Destination place ID is retained in route/session data so restored trips can recalculate.

9. **Visibility/orientation invalidation**
   - Hidden navigation stops the full session/calibration runtime, disables media tracks, removes the overlay, and resumes only into fresh calibration.
   - Screen-orientation changes invalidate active tracking and require re-alignment.
   - Actual `screen.orientation.angle`, including `+90`/`-90`, and the portrait video-dimension fallback are applied consistently to display, calibration, and sensor camera transforms.

10. **Worker startup fallback**
    - Worker initialization failure terminates the worker and attempts the throttled main-thread tracker exactly once.
    - Unavailable is reported only after dual startup failure; a worker that fails after becoming ready is terminated and reported unavailable.

11. **Route-broker rate limiting**
    - Added a bounded in-memory, fixed-window limiter (20 requests/minute, at most 10,000 clients) based on trusted hosting IP headers.
    - Missing, multi-value, or plain spoof-prone forwarding identity is rejected; limited requests return `429` and `Retry-After`.
    - Telemetry remains category/status/latency only. README documents per-instance limitations and the 500/day Google Routes quota as the distributed backstop.

12. **Production-boundary coverage**
    - Added/strengthened permission, route/session calibration, full-image tracker, renderer quality, worker fallback, visibility/orientation, re-alignment/recalculation, and service-worker cache tests.
    - Playwright now expects rotation/backgrounding to remove stale AR and require a new road alignment.

13. **Search callback race**
    - Autocomplete mounts once; its selection closure forwards to the latest callback.
    - App route selection reads the current origin from a ref, so immediate selection after location readiness cannot use a stale render value.

## TDD RED/GREEN evidence

Focused tests were written or strengthened before each production fix. Representative observed RED failures and their GREEN reruns:

| Finding | Command | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| 1, 13 | `npm test -- src/device/permissions.test.ts src/components/SearchScreen.test.tsx` | Motion was absent from the pre-await call order; autocomplete mounted twice after origin update. | Both boundaries passed. |
| 1 cleanup | `npm test -- src/device/permissions.test.ts src/pwa/cachePolicy.test.ts` | Synchronous motion exception was misclassified as camera-unavailable and the camera was not stopped. | 2 files, 9 tests passed. |
| 2, 3, 6, 7 | `npm test -- src/route/prepareRoute.test.ts src/route/polyline.test.ts src/navigation/navigationEngine.test.ts src/session/NavigationSession.test.ts` | Missing route preparation; explicit origin ignored; nonzero progress reset; first session position started away from calibration origin. | 4 files, 19 tests passed at the initial GREEN point. |
| 3 | `npm test -- src/components/CalibrationScreen.test.tsx` | Lock callback did not map the sampled `progress + dNear` point and still required the old near-point prop. | 2 tests passed. |
| 4 | `npm test -- src/tracking/residualHomography.test.ts src/tracking/OpenCvTracker.test.ts` | Missing sensor-homography/full-image conversion; translation did not accumulate; keyframe ID changed on ordinary frames. | 12 focused tests passed at the initial GREEN point; final tracker file has 8 passing tests including ROI-origin rotation and cleanup. |
| 4 sensor boundary | `npm test -- src/session/browserAdapters.test.ts` | No frame-time sensor compensator; later portrait fallback test showed an unrotated camera matrix. | Final 2 tests passed; combined display/viewport/adapters run passed 10 tests. |
| 5 | `npm test -- src/ar/RouteRenderer.test.ts` | Quality-state opacities were absent. | 3 tests passed for locked, weak, realign, and recovery. |
| 7–9 | `npm test -- src/app/App.integration.test.tsx` | Re-align restarted at zero, recalculate reused stale state, failure UX was wrong, and hidden navigation did not stop the session. | Final 7 integration tests passed, including physical orientation-change invalidation. |
| 8 | `npm test -- src/google/routeClient.test.ts src/app/App.integration.test.tsx` | Route plan omitted destination place ID. | Initial GREEN run passed 8 tests; final files contain 9 passing tests. |
| 9 | `npm test -- src/geometry/displayTransform.test.ts src/components/ArViewport.test.tsx src/session/browserAdapters.test.ts` | Screen-angle normalization/resolution and sensor rotation were missing/inconsistent. | 3 files, 10 tests passed. |
| 10 | `npm test -- src/tracking/TrackerClient.test.ts` | Worker startup rejection skipped fallback; dual-failure and runtime-unavailable states were wrong. | 6 tests passed. |
| 11 | `npm test -- api/routes.test.ts` | Rate-limiter API was missing. | 8 tests passed. |
| 12 cache | `npm test -- src/pwa/cachePolicy.test.ts` | Cache policy module was missing; later an image-like `/camera` request was incorrectly cacheable. | 2 tests passed, including same-origin/API/Google/POST/camera/location boundaries. |

The first post-change full E2E run produced 2 failures because its legacy rotation assertion expected the AR viewport to remain visible. The scenario was strengthened to require calibration after rotation/backgrounding. `npx playwright test e2e/navigation.spec.ts` then passed 4/4 before the final full E2E run.

## Final verification

Executed from the worktree after the final source/test edits:

- `npm test` — PASS: 38 test files, 165 tests.
- `npm run typecheck` — PASS: `tsc -b --pretty false`.
- `npm run lint` — PASS: `eslint .`.
- `npm run build` — PASS: 138 modules transformed and production bundle emitted.
- `npm run e2e` — PASS: 8/8 Playwright scenarios across Android Chromium and iPhone WebKit projects.
- `rg -n "GOOGLE_ROUTES_SERVER_KEY|AIza" dist src public` — PASS: no matches.
- `git diff --check` — PASS; Git only reported the repository's Windows LF-to-CRLF conversion notices.
- `rg -n "Field status: \*\*PENDING\*\*" docs/device-testing.md` — PASS at line 103.

The production build still emits the pre-existing OpenCV package warnings for browser-externalized `fs`/`crypto` imports and large lazy OpenCV chunks; it exits successfully and OpenCV remains loaded only at AR startup.

## Files changed

### Application and route/session flow

- `src/app/App.tsx`
- `src/app/App.integration.test.tsx`
- `src/domain/types.ts`
- `src/google/routeClient.ts`
- `src/google/routeClient.test.ts`
- `src/google/routeSchemas.ts`
- `src/navigation/navigationEngine.ts`
- `src/navigation/navigationEngine.test.ts`
- `src/route/polyline.ts`
- `src/route/polyline.test.ts`
- `src/route/prepareRoute.ts`
- `src/route/prepareRoute.test.ts`
- `src/session/NavigationSession.ts`
- `src/session/NavigationSession.test.ts`
- `src/session/sessionStore.ts`

### Calibration, display, and UI

- `src/components/ArViewport.tsx`
- `src/components/CalibrationScreen.tsx`
- `src/components/CalibrationScreen.test.tsx`
- `src/components/SearchScreen.tsx`
- `src/components/SearchScreen.test.tsx`
- `src/device/permissions.ts`
- `src/device/permissions.test.ts`
- `src/geometry/displayTransform.ts`
- `src/geometry/displayTransform.test.ts`
- `src/session/browserAdapters.ts`
- `src/session/browserAdapters.test.ts`
- `src/session/browserCalibration.ts`

### Tracking and rendering

- `src/ar/RouteRenderer.ts`
- `src/ar/RouteRenderer.test.ts`
- `src/test/fakes/FakeRenderer.ts`
- `src/tracking/OpenCvTracker.ts`
- `src/tracking/OpenCvTracker.test.ts`
- `src/tracking/TrackerClient.ts`
- `src/tracking/TrackerClient.test.ts`
- `src/tracking/residualHomography.ts`
- `src/tracking/residualHomography.test.ts`

### Server, PWA, E2E, and documentation

- `api/routes.ts`
- `api/routes.test.ts`
- `src/pwa/cachePolicy.ts`
- `src/pwa/cachePolicy.test.ts`
- `src/sw.ts`
- `e2e/fixtures/fakeMobile.ts`
- `e2e/navigation.spec.ts`
- `README.md`
- `.superpowers/sdd/2026-08-21-ar-walking-navigation-mvp/final-review-fix-report.md`

## Self-review

- Reviewed the whole diff from the stated base, not only individual patches.
- Confirmed homography order follows the repository's column-vector convention and ROI transforms are conjugated as `T_current^-1 H_tracking T_previous`.
- Confirmed keyframe replacement preserves the current bounded full-image correction and OpenCV resources are not double-deleted.
- Confirmed recalculation aborts prior route work and releases camera/tracker/session resources before requesting a fresh fix/route.
- Confirmed hidden/orientation transitions remove the AR viewport and cannot render stale locked confidence.
- Confirmed the route broker does not log client IDs, coordinates, destinations, route polylines, keys, or user-agent fingerprints.
- Confirmed only route and non-sensitive progress are stored in `sessionStorage`; camera frames, visual features, homographies, and raw location history are neither persisted nor uploaded.
- Confirmed service-worker caching is restricted to same-origin static GET/navigations and excludes API, Google, camera, and location-like paths.
- Confirmed no hard-coded Google key or server-key identifier is present in `dist`, `src`, or `public`.
- Confirmed the physical-device checklist remains `PENDING`; no physical-device validation is claimed.

## Concerns and follow-up

- Physical iPhone Safari and Android Chrome field acceptance is still pending by design and remains the release gate for field-ready claims.
- The rate limiter is intentionally best-effort and per serverless instance; Google Cloud's 500/day Routes quota remains the distributed hard backstop.
- The successful build reports large OpenCV chunks and `fs`/`crypto` browser-externalization warnings from `@techstark/opencv-js`; these are known packaging/performance concerns, not acceptance failures in this wave.
