import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createGoogleDestinationSearchAdapter,
  SearchScreen,
  type DestinationSearchAdapter
} from "../components/SearchScreen";
import {
  createGoogleRouteMapAdapter,
  RoutePreview,
  type RouteMapAdapter
} from "../components/RoutePreview";
import type { Destination, RoutePlan } from "../domain/types";
import {
  requestCurrentLocation,
  type LocationFix
} from "../device/location";
import {
  requestWalkingRoute,
  type WalkingRouteInput
} from "../google/routeClient";

type AppProps = {
  destinationAdapter?: DestinationSearchAdapter;
  mapAdapter?: RouteMapAdapter;
  requestLocation?: (signal: AbortSignal) => Promise<LocationFix>;
  requestRoute?: (
    input: WalkingRouteInput,
    signal: AbortSignal
  ) => Promise<RoutePlan>;
};

const browserKey = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY ?? "";

export function App({
  destinationAdapter: providedDestinationAdapter,
  mapAdapter: providedMapAdapter,
  requestLocation = requestCurrentLocation,
  requestRoute = requestWalkingRoute
}: AppProps = {}) {
  const destinationAdapter = useMemo(
    () =>
      providedDestinationAdapter ??
      createGoogleDestinationSearchAdapter(browserKey),
    [providedDestinationAdapter]
  );
  const mapAdapter = useMemo(
    () => providedMapAdapter ?? createGoogleRouteMapAdapter(browserKey),
    [providedMapAdapter]
  );
  const [originFix, setOriginFix] = useState<LocationFix>();
  const [selectedDestination, setSelectedDestination] =
    useState<Destination>();
  const [route, setRoute] = useState<RoutePlan>();
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string>();
  const activeRouteRequest = useRef<AbortController | null>(null);

  const loadRoute = useCallback(
    (origin: LocationFix, destination: Destination) => {
      activeRouteRequest.current?.abort();
      const controller = new AbortController();
      activeRouteRequest.current = controller;
      setRoute(undefined);
      setRouteLoading(true);
      setRouteError(undefined);
      void requestRoute(
        { origin: origin.point, destination },
        controller.signal
      )
        .then((nextRoute) => {
          if (!controller.signal.aborted) setRoute(nextRoute);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setRouteError(
            error instanceof Error
              ? error.message
              : "The walking route could not be loaded."
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setRouteLoading(false);
        });
    },
    [requestRoute]
  );

  const chooseDestination = useCallback(
    (destination: Destination) => {
      setSelectedDestination(destination);
      if (!originFix) {
        setRouteError("Use your current location before calculating the route.");
        return;
      }
      loadRoute(originFix, destination);
    },
    [loadRoute, originFix]
  );

  const chooseOrigin = useCallback(
    (fix: LocationFix) => {
      setOriginFix(fix);
      if (selectedDestination) loadRoute(fix, selectedDestination);
    },
    [loadRoute, selectedDestination]
  );

  useEffect(
    () => () => {
      activeRouteRequest.current?.abort();
    },
    []
  );

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="app-title">
        <p className="eyebrow">Outdoor walking navigation</p>
        <h1 id="app-title">Walk with AR</h1>
        <p className="hero-copy">
          Search for a destination, then follow bright route markers placed on
          the road through your camera.
        </p>
      </section>

      <aside className="safety-note" aria-label="Safety notice">
        <span aria-hidden="true">!</span>
        <p>
          Stay aware of traffic and your surroundings. Never use while driving.
        </p>
      </aside>

      {route ? (
        <RoutePreview
          route={route}
          mapAdapter={mapAdapter}
          onStart={() => undefined}
          onBack={() => setRoute(undefined)}
        />
      ) : (
        <>
          <SearchScreen
            destinationAdapter={destinationAdapter}
            requestLocation={requestLocation}
            onLocation={chooseOrigin}
            onDestination={chooseDestination}
            origin={originFix?.point}
          />
          {routeLoading && (
            <p className="route-request-status" role="status">
              Calculating your walking route…
            </p>
          )}
          {routeError && (
            <aside className="route-error" role="alert">
              <p>{routeError}</p>
              {originFix && selectedDestination && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => loadRoute(originFix, selectedDestination)}
                >
                  Retry route
                </button>
              )}
            </aside>
          )}
        </>
      )}
    </main>
  );
}
