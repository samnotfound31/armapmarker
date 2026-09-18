# Walk with AR

Walk with AR is a browser-only walking-navigation MVP for current Android Chrome and iPhone Safari. A user searches for a destination, previews a walking route, grants camera/location/motion access, aligns the route to the visible road, and follows green metric arrows and bars rendered over the live camera view. The temporary MVP provider is openrouteservice/HeiGIT; the AR pipeline remains provider-neutral.

This build is an engineering MVP, not a production navigation product. Automated tests cover the application flow and simulated mobile browsers, but the road-locking behavior must pass the real-device checklist on both iPhone and Android before it can be described as field-ready.

## Safety

- Use only while walking outdoors in a safe pedestrian area.
- Never use this interface while driving, cycling, or crossing traffic without looking up.
- The overlay is guidance, not a guarantee that a surface is walkable or safe.
- Stop and use the route preview whenever tracking looks wrong.

## Local setup

Requirements: Node.js 24 or newer, npm, and a free HeiGIT account with an API key.

1. Copy `.env.example` to `.env.local`.
2. Set `OPENROUTESERVICE_API_KEY` to the key from the [HeiGIT account page](https://account.heigit.org/).
3. Install dependencies:

   ```bash
   npm install
   ```

4. For full local search and routing, start the project with the Vercel CLI so
   `/api/search` and `/api/routes` are available:

   ```bash
   npx vercel dev
   ```

   `npm run dev` starts only the Vite browser UI; use it for provider-independent
   frontend work, not end-to-end destination or route testing.

Camera, motion, and geolocation require a secure context. `localhost` works for desktop development; a phone must use an HTTPS deployment or an HTTPS development tunnel.

### openrouteservice/HeiGIT configuration

The browser never receives the HeiGIT key. Destination autocomplete is sent as a same-origin `POST /api/search`, and walking routes are requested through `POST /api/routes`. Both Vercel functions authenticate upstream with the server-only `OPENROUTESERVICE_API_KEY` environment variable.

The provider integration uses HeiGIT Pelias autocomplete for destination search and openrouteservice `foot-walking` GeoJSON directions for pedestrian routes. All provider endpoints and authentication headers are centralized in `api/providers/heigitConfig.ts`.

The search and route brokers apply best-effort per-client limits from trusted hosting IP headers. Their bounded in-memory state is local to each serverless instance, so it is not a distributed quota or abuse-prevention guarantee. Monitor the quota shown in the HeiGIT account and keep autocomplete debounced. The public service can return `429` when a minute or daily limit is reached.

The route preview is a local schematic drawing of the returned geometry and does not load third-party map tiles. Required attribution remains visible in the preview: `© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors`.

Google Maps/Places adapters and their optional environment-variable names remain in the repository as a future provider option, but they are inactive in this ORS MVP. Restoring Google requires selecting those adapters in `App.tsx`, restoring the required CSP origins, and configuring the corresponding restricted keys; it does not require changes to `RoutePlan` or the AR pipeline.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the provider-independent Vite UI only |
| `npx vercel dev` | Start the UI and local search/route functions |
| `npm test` | Run unit and integration tests |
| `npm run typecheck` | Check TypeScript |
| `npm run lint` | Run ESLint |
| `npm run build` | Create the production build |
| `npm run e2e:install` | Install Chromium and WebKit test browsers |
| `npm run e2e` | Run Pixel/Chromium and iPhone/WebKit scenarios |

## How the MVP works

1. HeiGIT Pelias resolves a destination and the server route broker requests an openrouteservice pedestrian route.
2. The encoded route is converted to a local east/north/up metric frame and resampled.
3. A short calibration estimates camera height and fixes the route ground plane from phone orientation plus two user road taps.
4. GPS determines global route progress. Device orientation provides the earth-relative camera pose.
5. A lazy-loaded OpenCV optical-flow tracker estimates a bounded visual residual so short-term phone motion does not make the overlay swim.
6. Three.js projects green route bars and maneuver arrows into the camera view. Weak tracking, route deviation, and arrival each have explicit recovery states.

The app deliberately keeps GPS as the authority for route progress. Visual tracking stabilizes the local overlay; it does not silently move the user along the route.

## Privacy and data handling

- Camera frames, feature points, and homographies stay in the browser and are never uploaded by this app.
- The search broker receives the typed destination query and optional current-location bias needed for Pelias. The route broker receives only the selected origin and destination needed for pedestrian routing.
- Raw location history is not persisted. `sessionStorage` contains only the active route and non-sensitive session progress needed for refresh recovery.
- Search and route telemetry records result category, status, and latency—not coordinates, search text, or API keys.
- The service worker caches only same-origin static shell assets. It excludes `/api/`, camera/location data, calibration state, and session data.

Review the hosting provider's request logs and the [openrouteservice terms](https://openrouteservice.org/terms-of-service/) before inviting external testers.

## Current limitations

- Calibration uses an approximate 65° camera field of view because mobile browsers do not expose reliable camera intrinsics.
- The road model is locally planar; steep slopes, stairs, bridges, and abrupt elevation changes can misalign the overlay.
- Tracking works best outdoors on textured roads in good light. Blank asphalt, glare, darkness, rain, crowds, and motion blur can trigger re-alignment.
- Browser sensor permissions and orientation behavior vary by OS/browser version.
- OpenCV is loaded only when AR starts, but its compressed worker/fallback payload is approximately 4 MB per path.
- OpenStreetMap/Pelias coverage and openrouteservice pedestrian routes can differ from Google, and selected coordinates must be close enough to a routable path.
- Public HeiGIT quotas, availability, and terms can change; confirm them before each public test.
- The temporary preview shows route geometry without a surrounding street basemap.
- A real iPhone Safari and Android Chrome field pass is still required.

## Deployment

The repository includes `vercel.json` for SPA routing, `/api/search` and `/api/routes` server functions, no-store API responses, a restrictive Content Security Policy, and camera/location/sensor permissions limited to the same origin.

The pinned `@techstark/opencv-js` runtime compiles WebAssembly and constructs Embind functions dynamically, so `script-src` explicitly allows both `'wasm-unsafe-eval'` and `'unsafe-eval'`. The latter weakens script-injection defense even though script origins remain restricted to this app. A future hardening migration should replace the package with a CSP-safe OpenCV build that uses precompiled bindings, verify it with the production-header runtime smoke, and then remove `'unsafe-eval'` (and `'wasm-unsafe-eval'` if the replacement no longer compiles Wasm in-browser).

Deploy the repository to Vercel, configure `OPENROUTESERVICE_API_KEY` there, and test only through the generated HTTPS URL. Do not put the server key in client-visible project settings or any `VITE_` variable.

## Project documents

- [Approved implementation design](docs/superpowers/specs/2026-08-21-ar-walking-navigation-mvp-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-21-ar-walking-navigation-mvp.md)
- [Physical-device test checklist](docs/device-testing.md)
