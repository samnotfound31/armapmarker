# Outdoor iPhone demo

Use the feature branch Preview. Add `?arDebug=1` to show the temporary local diagnostic panel; remove that parameter to hide it. The panel contains counts, confidence and rejection categories, with no coordinates, camera data or credentials. Nothing from the panel is uploaded.

## Walkthrough

1. Outdoors, search for a destination and load its walking route.
2. Start AR and grant camera/motion access.
3. While standing still, point along the walking path with ground in view.
4. A translucent route appears. Tap the path once, a few metres ahead.
5. The overlay starts immediately as approximate guidance. Visual evidence increases confidence.
6. Walk a short 20–30 m segment. Brief tracking weakness dims the markers and recovers automatically.
7. If re-alignment is requested, stop, point along the path, and tap once again. “Adjust alignment” offers the same flow whenever needed.

Direction nudges are optional under “Adjust direction if needed” before the tap. There is no mandatory height selection, exact near/far tap pair, feature scan, or separate lock button.

## What the estimate assumes

This remains a browser demo on approximately flat ground. Camera height uses a 1.4 m prior; camera intrinsics use the existing approximate field of view. Route tangent plus one tap sets forward direction without requiring an accurate compass or tapped metric distance. Device orientation supplies the fast gravity/orientation prior, OpenCV supplies bounded local correction, and GPS continues to own route progress and maneuver distance. This is not centimetre-accurate reconstruction.

## Recovery policy

- Invalid geometry or insufficient evidence rejects that visual measurement. It does not stop the tracker or replace the last accepted correction.
- The first poor frame marks tracking weak. Geometry remains present at reduced opacity while the existing visual correction ages out smoothly and sensor orientation continues.
- Three stable updates recover a previously locked estimate.
- Thirty critical updates or three seconds of continuously poor evidence requests re-alignment. Markers are hidden in that unsafe state; tracking continues and may recover automatically.
- Nonrecoverable camera, WebGL or OpenCV initialization/runtime failures retain the existing safe exit behavior.

Validation includes finite/nonsingular matrices, orientation preservation across the image, inlier count/ratio/error and spatial support, bounded change in residual scale/rotation/perspective, and the existing maximum visual displacement bound. Validation has not been disabled.

## Marker diagnostics

The short route begins 3 m ahead, with 2.5 m spacing over the next 28 m. Diagnostics report sampled route anchors ahead, transformed anchors, anchors in front, projected anchors, visible marker centres, and markers submitted with visible opacity. These counts describe the projection/render submission, not a GPU pixel readback. Browser regressions separately verify actual green overlay pixels after drawing.

A zero count is explained by no route ahead, invalid transform, behind-camera, outside-viewport, or tracking-realign. The normal UI also prompts the user to point toward the path when projection has no visible markers.

## Fixed causes

- Three.js automatic camera updates overwrote the supplied camera transform at render time, despite correct HUD and CPU projection. The renderer now explicitly owns the camera matrices.
- Candidate homography validation exceptions escaped the tracker and triggered permanent worker unavailability. Validation now rejects individual visual measurements while retaining the accepted transform.
- Calibration previously gated rendering behind height, pose capture, two metric taps, and twenty feature-scan samples. The default flow now uses a provisional estimate and one directional ground anchor.

## Limits of automated evidence

Regression coverage uses the real app, renderer, OpenCV and workers with synthetic camera/motion data in Chromium and WebKit. It covers visible pixels, weak recovery, sustained loss, one-tap re-alignment and cleanup. Physical iPhone permission behavior, outdoor texture/lighting, real walking stability, GPS drift and sustained device performance still require the short field test above.
