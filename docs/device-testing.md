# Physical-device acceptance checklist

Complete this checklist on a deployed HTTPS build. Do not mark the MVP production-ready until every blocking check has passed on both a current iPhone Safari device and a current Android Chrome device.

## Test record

| Field | iPhone run | Android run |
| --- | --- | --- |
| Date/time |  |  |
| Tester |  |  |
| Device model |  |  |
| OS version |  |  |
| Browser version |  |  |
| Git commit/deployment URL |  |  |
| Weather/light |  |  |
| Test site and route length |  |  |

## Blocking acceptance checks

Run every item separately on iPhone Safari and Android Chrome.

### Setup and permissions

- [ ] App loads over HTTPS with no console or certificate error.
- [ ] Location can be granted from the user gesture and current position appears.
- [ ] Camera permission can be granted and the rear camera fills the viewport.
- [ ] Motion/orientation permission works where the OS requires a separate gesture.
- [ ] Denying camera permission produces actionable recovery instructions.
- [ ] Denying location permission produces actionable recovery instructions.
- [ ] Returning from system settings and retrying reaches calibration without a reload loop.

### Route search and preview

- [ ] Search suggestions are relevant and keyboard selection works.
- [ ] A walking route displays the correct destination, duration, and distance.
- [ ] Starting AR does not expose the server API key in page source, network responses, or built assets.
- [ ] A failed or quota-limited route request gives a retryable error without leaking coordinates into logs.

### Calibration and road lock

- [ ] Standing-height input is understandable and can be changed.
- [ ] Stability indicator does not accept obviously moving calibration.
- [ ] Two road taps can be placed on the visible road in portrait.
- [ ] The scan step completes and explains failure on a blank/low-texture surface.
- [ ] On a straight road, arrows remain on the road while the phone pans left/right and pitches up/down.
- [ ] On a curved route, markers follow the intended walking path rather than a straight screen-space line.
- [ ] Portrait-to-landscape-to-portrait rotation preserves a usable overlay or requests re-alignment.
- [ ] Bright sun, mixed shadow, and normal evening light each keep acceptable road lock.
- [ ] A low-texture asphalt section enters weak tracking without a sudden marker jump.
- [ ] Normal walking bob and moderate hand shake do not move global route progress.

### Navigation recovery

- [ ] Weak tracking warning appears before the overlay becomes misleading.
- [ ] Tracking loss freezes/hides unsafe guidance and offers re-alignment.
- [ ] Re-align returns to calibration and then resumes the active route.
- [ ] Leaving the route presents recalculate and keep-current-route choices.
- [ ] Recalculate requests and loads a new walking route from the current position.
- [ ] Keep current route dismisses the warning without corrupting progress.
- [ ] Arrival triggers near the destination and releases camera/tracking resources.
- [ ] Screen lock, tab backgrounding, and returning to the app recover safely.
- [ ] With a previously loaded route, temporary network loss leaves the current static UI usable and does not cache route API responses.

### Endurance and device behavior

- [ ] A continuous 20-minute walk completes without a crash, runaway memory, or unusable frame-rate drop.
- [ ] Device temperature remains acceptable and any OS thermal throttling is recorded.
- [ ] Battery percentage before/after the 20-minute run is recorded below.
- [ ] Ending navigation turns off the camera indicator and stops location/orientation watchers.
- [ ] Refreshing or closing the tab does not retain camera frames or raw location history.

| Measurement | iPhone | Android |
| --- | ---: | ---: |
| Battery before |  |  |
| Battery after 20 min |  |  |
| Approximate frame rate start/end |  |  |
| Peak observed device temperature/OS warning |  |  |

## Safety and privacy observation

- [ ] Test route is a low-risk pedestrian area with a second person observing traffic.
- [ ] Tester can always see enough live camera imagery to walk safely.
- [ ] Guidance is stopped immediately when it points onto traffic, barriers, stairs, or non-walkable space.
- [ ] Network inspection confirms camera imagery is never uploaded.
- [ ] Network inspection confirms service-worker caches contain only same-origin static assets.
- [ ] Hosting logs contain no coordinates, destination search text, or secret keys.

## Threshold change log

Record every adjustment to tracking, off-route, or arrival thresholds. Link supporting runs; do not tune from a single favorable route.

| Date | Commit | Device/site | Threshold changed | Before → after | Evidence and reason |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Sign-off

- [ ] All blocking iPhone Safari checks passed.
- [ ] All blocking Android Chrome checks passed.
- [ ] Any safety-critical failure has a reproducible test and a reviewed fix.
- [ ] Product language still describes the overlay as assistive guidance, not ground truth.

Field status: **PENDING** until both platform sign-offs above are complete.
