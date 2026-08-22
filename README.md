# Walk with AR

Walk with AR is a browser-only walking-navigation MVP for current Android Chrome and iPhone Safari. A user searches for a destination, previews a Google walking route, grants camera/location/motion access, aligns the route to the visible road, and follows green metric arrows and bars rendered over the live camera view.

This build is an engineering MVP, not a production navigation product. Automated tests cover the application flow and simulated mobile browsers, but the road-locking behavior must pass the real-device checklist on both iPhone and Android before it can be described as field-ready.

## Safety

- Use only while walking outdoors in a safe pedestrian area.
- Never use this interface while driving, cycling, or crossing traffic without looking up.
- The overlay is guidance, not a guarantee that a surface is walkable or safe.
- Stop and use the route preview whenever tracking looks wrong.

## Local setup

Requirements: Node.js 24 or newer, npm, and a Google Cloud project with billing enabled.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_GOOGLE_MAPS_BROWSER_KEY` to a browser-restricted key.
3. Set `GOOGLE_ROUTES_SERVER_KEY` to a separate server-side key.
4. Install and start the app:

   ```bash
   npm install
   npm run dev
   ```

Camera, motion, and geolocation require a secure context. `localhost` works for desktop development; a phone must use an HTTPS deployment or an HTTPS development tunnel.

### Google Cloud configuration

Enable these services for the project:

- Maps JavaScript API
- Places API (New)
- Routes API

Restrict the browser key by the deployed HTTPS referrer and allow only Maps JavaScript and Places. Keep the Routes key server-side, restrict it to the Routes API, and add an IP or supported server restriction when the hosting platform makes one available. Never expose `GOOGLE_ROUTES_SERVER_KEY` through a `VITE_` variable.

The route broker also applies a best-effort per-client limit of 20 requests per minute from trusted hosting IP headers. Its bounded in-memory state is local to each serverless instance, so it is not a distributed quota or abuse-prevention guarantee. Keep Google Cloud's hard daily Routes quota (500 requests for the initial MVP) as the distributed backstop, and review hosting logs without recording client IPs or coordinates.

[Google Maps Platform requires billing and uses pay-as-you-go pricing](https://developers.google.com/maps/billing-and-pricing/billing-overview). Its per-SKU free usage caps may cover a small prototype, but the APIs should not be treated as unlimited or guaranteed free. Before field testing, set billing alerts and conservative daily request quotas—for example 500 Routes requests, 2,000 autocomplete requests, and 1,000 dynamic map loads—then adjust from observed use and the [current pricing categories](https://developers.google.com/maps/billing-and-pricing/pricing-categories).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Vite server |
| `npm test` | Run unit and integration tests |
| `npm run typecheck` | Check TypeScript |
| `npm run lint` | Run ESLint |
| `npm run build` | Create the production build |
| `npm run e2e:install` | Install Chromium and WebKit test browsers |
| `npm run e2e` | Run Pixel/Chromium and iPhone/WebKit scenarios |

## How the MVP works

1. Google Places resolves a destination and the server route broker requests a walking route.
2. The encoded route is converted to a local east/north/up metric frame and resampled.
3. A short calibration estimates camera height and fixes the route ground plane from phone orientation plus two user road taps.
4. GPS determines global route progress. Device orientation provides the earth-relative camera pose.
5. A lazy-loaded OpenCV optical-flow tracker estimates a bounded visual residual so short-term phone motion does not make the overlay swim.
6. Three.js projects green route bars and maneuver arrows into the camera view. Weak tracking, route deviation, and arrival each have explicit recovery states.

The app deliberately keeps GPS as the authority for route progress. Visual tracking stabilizes the local overlay; it does not silently move the user along the route.

## Privacy and data handling

- Camera frames, feature points, and homographies stay in the browser and are never uploaded by this app.
- The server route broker receives only the selected origin and destination needed to call Google Routes.
- Raw location history is not persisted. `sessionStorage` contains only the active route and non-sensitive session progress needed for refresh recovery.
- Route API telemetry records result category, status, and latency—not coordinates, search text, or API keys.
- The service worker caches only same-origin static shell assets. It excludes `/api/`, Google requests, camera/location data, calibration state, and session data.

Review the hosting provider's request logs and Google Maps Platform terms before inviting external testers.

## Current limitations

- Calibration uses an approximate 65° camera field of view because mobile browsers do not expose reliable camera intrinsics.
- The road model is locally planar; steep slopes, stairs, bridges, and abrupt elevation changes can misalign the overlay.
- Tracking works best outdoors on textured roads in good light. Blank asphalt, glare, darkness, rain, crowds, and motion blur can trigger re-alignment.
- Browser sensor permissions and orientation behavior vary by OS/browser version.
- OpenCV is loaded only when AR starts, but its compressed worker/fallback payload is approximately 4 MB per path.
- Google API cost, quota, and terms can change; confirm them before each public test.
- A real iPhone Safari and Android Chrome field pass is still required.

## Deployment

The repository includes `vercel.json` for SPA routing, the `/api/routes` server function, no-store API responses, a restrictive Content Security Policy, and camera/location/sensor permissions limited to the same origin.

Deploy the repository to Vercel, configure both environment variables there, and test only through the generated HTTPS URL. Do not put the server key in client-visible project settings.

## Project documents

- [Approved implementation design](docs/superpowers/specs/2026-08-21-ar-walking-navigation-mvp-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-21-ar-walking-navigation-mvp.md)
- [Physical-device test checklist](docs/device-testing.md)
