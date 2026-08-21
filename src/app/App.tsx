import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RouteRenderBackendFactory } from "../ar/RouteRenderer";
import { ArViewport } from "../components/ArViewport";
import { ArrivalScreen } from "../components/ArrivalScreen";
import { CalibrationScreen } from "../components/CalibrationScreen";
import { NavigationHud } from "../components/NavigationHud";
import { PermissionScreen } from "../components/PermissionScreen";
import { UpdatePrompt } from "../components/UpdatePrompt";
import {
  createGoogleRouteMapAdapter,
  RoutePreview,
  type RouteMapAdapter
} from "../components/RoutePreview";
import {
  createGoogleDestinationSearchAdapter,
  SearchScreen,
  type DestinationSearchAdapter
} from "../components/SearchScreen";
import type {
  Destination,
  GroundCalibration,
  LocalRoutePoint,
  RouteGroundPoint,
  RoutePlan,
  TrackingQuality
} from "../domain/types";
import { stopMediaStream } from "../device/camera";
import { requestCurrentLocation, type LocationFix } from "../device/location";
import { requestArAccess, type ArAccessGrant } from "../device/permissions";
import { requestWalkingRoute, type WalkingRouteInput } from "../google/routeClient";
import { selectNextManeuver } from "../navigation/navigationEngine";
import { PoseFusion } from "../pose/PoseFusion";
import { toEnu } from "../route/geo";
import { decodeAndSampleRoute } from "../route/polyline";
import { nearestRouteProgress } from "../route/progress";
import {
  NavigationSession,
  type NavigationRuntimeSnapshot,
  type NavigationSessionOptions
} from "../session/NavigationSession";
import { createBrowserNavigationAdapters } from "../session/browserAdapters";
import {
  createBrowserCalibrationRuntime,
  type BrowserCalibrationRuntime
} from "../session/browserCalibration";
import { createSessionStore, type SessionStore } from "../session/sessionStore";

export type CalibrationRuntime = BrowserCalibrationRuntime;

export type NavigationSessionLike = {
  start(): Promise<void>;
  stop(): void;
};

export type AppNavigationSessionInput = Omit<
  NavigationSessionOptions,
  "adapters"
> & {
  grant: ArAccessGrant;
};

type AppProps = {
  destinationAdapter?: DestinationSearchAdapter;
  mapAdapter?: RouteMapAdapter;
  requestLocation?: (signal: AbortSignal) => Promise<LocationFix>;
  requestRoute?: (
    input: WalkingRouteInput,
    signal: AbortSignal
  ) => Promise<RoutePlan>;
  requestAccess?: (
    video: HTMLVideoElement,
    signal: AbortSignal
  ) => Promise<ArAccessGrant>;
  createCalibrationRuntime?: (grant: ArAccessGrant) => CalibrationRuntime;
  createSession?: (input: AppNavigationSessionInput) => NavigationSessionLike;
  backendFactory?: RouteRenderBackendFactory;
  sessionStore?: SessionStore;
};

type AppStage =
  | "search"
  | "preview"
  | "permissions"
  | "calibration"
  | "navigating"
  | "arrived";

type PreparedRoute = {
  localRoute: LocalRoutePoint[];
  groundRoute: RouteGroundPoint[];
  routeNearPoint: RouteGroundPoint;
};

const browserKey = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY ?? "";
const INITIAL_QUALITY: TrackingQuality = {
  state: "weak",
  featureCount: 0,
  inlierCount: 0,
  inlierRatio: 0,
  medianReprojectionErrorPx: Number.POSITIVE_INFINITY
};

export function App({
  destinationAdapter: providedDestinationAdapter,
  mapAdapter: providedMapAdapter,
  requestLocation = requestCurrentLocation,
  requestRoute = requestWalkingRoute,
  requestAccess = requestArAccess,
  createCalibrationRuntime: calibrationFactory = ({ stream }) =>
    createBrowserCalibrationRuntime(stream),
  createSession: sessionFactory = createDefaultSession,
  backendFactory,
  sessionStore: providedSessionStore
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
  const store = useMemo(
    () => providedSessionStore ?? safeSessionStore(),
    [providedSessionStore]
  );
  const restored = useMemo(() => store.load(), [store]);
  const [stage, setStage] = useState<AppStage>(restored ? "preview" : "search");
  const [originFix, setOriginFix] = useState<LocationFix>();
  const [selectedDestination, setSelectedDestination] = useState<Destination>();
  const [route, setRoute] = useState<RoutePlan | undefined>(restored?.route);
  const [preparedRoute, setPreparedRoute] = useState<PreparedRoute>();
  const [grant, setGrant] = useState<ArAccessGrant>();
  const [calibrationRuntime, setCalibrationRuntime] =
    useState<CalibrationRuntime>();
  const [calibration, setCalibration] = useState<GroundCalibration>();
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<NavigationRuntimeSnapshot>();
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string>();
  const [compatibilityMessage, setCompatibilityMessage] = useState<string>();
  const [dismissedOffRoute, setDismissedOffRoute] = useState(false);
  const activeRouteRequest = useRef<AbortController | null>(null);
  const activeArGrant = useRef<ArAccessGrant | null>(null);
  const activeCalibrationRuntime = useRef<CalibrationRuntime | null>(null);
  const activeSession = useRef<NavigationSessionLike | null>(null);

  const loadRoute = useCallback(
    (origin: LocationFix, destination: Destination) => {
      activeRouteRequest.current?.abort();
      const controller = new AbortController();
      activeRouteRequest.current = controller;
      setRoute(undefined);
      setStage("search");
      setRouteLoading(true);
      setRouteError(undefined);
      setCompatibilityMessage(undefined);
      void requestRoute({ origin: origin.point, destination }, controller.signal)
        .then((nextRoute) => {
          if (controller.signal.aborted) return;
          setRoute(nextRoute);
          setStage("preview");
          store.save({ route: nextRoute, stage: "preview", displayedProgressMeters: 0 });
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
    [requestRoute, store]
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

  const releaseCalibrationRuntime = () => {
    activeCalibrationRuntime.current?.dispose();
    activeCalibrationRuntime.current = null;
    setCalibrationRuntime(undefined);
  };

  const releaseSession = () => {
    activeSession.current?.stop();
    activeSession.current = null;
  };

  const releaseGrant = () => {
    const current = activeArGrant.current;
    if (current) stopMediaStream(current.stream);
    activeArGrant.current = null;
    setGrant(undefined);
  };

  const returnToPreview = (message?: string) => {
    releaseSession();
    releaseCalibrationRuntime();
    releaseGrant();
    setCalibration(undefined);
    setRuntimeSnapshot(undefined);
    setDismissedOffRoute(false);
    if (message) setCompatibilityMessage(message);
    if (route) {
      setStage("preview");
      store.save({ route, stage: "preview", displayedProgressMeters: 0 });
    } else {
      setStage("search");
    }
  };

  useEffect(
    () => () => {
      activeRouteRequest.current?.abort();
      activeSession.current?.stop();
      activeCalibrationRuntime.current?.dispose();
      if (activeArGrant.current) stopMediaStream(activeArGrant.current.stream);
    },
    []
  );

  const startCalibration = (nextGrant: ArAccessGrant) => {
    if (!route) {
      stopMediaStream(nextGrant.stream);
      return;
    }
    try {
      const nextPreparedRoute = prepareRoute(route, nextGrant.location);
      const runtime = calibrationFactory(nextGrant);
      activeArGrant.current = nextGrant;
      activeCalibrationRuntime.current = runtime;
      setGrant(nextGrant);
      setPreparedRoute(nextPreparedRoute);
      setCalibrationRuntime(runtime);
      setStage("calibration");
      store.save({ route, stage: "calibration", displayedProgressMeters: 0 });
    } catch (error) {
      stopMediaStream(nextGrant.stream);
      setCompatibilityMessage(
        error instanceof Error ? error.message : "Route calibration could not start."
      );
      setStage("preview");
    }
  };

  const startNavigation = (lockedCalibration: GroundCalibration) => {
    if (!route || !preparedRoute || !grant) return;
    releaseCalibrationRuntime();
    setCalibration(lockedCalibration);
    setRuntimeSnapshot(createInitialSnapshot(route, lockedCalibration));
    setStage("navigating");
    setCompatibilityMessage(undefined);

    const handleUnavailable = (message: string) => {
      returnToPreview(`${message} AR overlay stopped; the route preview is still available.`);
    };
    const session = sessionFactory({
      route,
      localRoute: preparedRoute.localRoute,
      groundRoute: preparedRoute.groundRoute,
      calibration: lockedCalibration,
      grant,
      onUpdate: (snapshot) => {
        setRuntimeSnapshot(snapshot);
        if (!snapshot.navigation.offRoute) setDismissedOffRoute(false);
        store.save({
          route,
          stage: "navigating",
          displayedProgressMeters: snapshot.navigation.routeProgressMeters
        });
      },
      onUnavailable: handleUnavailable,
      onArrived: (snapshot) => {
        setRuntimeSnapshot(snapshot);
        activeSession.current?.stop();
        activeSession.current = null;
        releaseGrant();
        setStage("arrived");
      }
    });
    activeSession.current = session;
    store.save({
      route,
      stage: "navigating",
      displayedProgressMeters: lockedCalibration.calibrationRouteDistanceMeters
    });
    void session.start().catch((error: unknown) => {
      if (activeSession.current !== session) return;
      handleUnavailable(
        error instanceof Error ? error.message : "Visual tracking could not start."
      );
    });
  };

  const realign = () => {
    if (!grant || !route) return;
    releaseSession();
    setRuntimeSnapshot(undefined);
    setCalibration(undefined);
    try {
      const runtime = calibrationFactory(grant);
      activeCalibrationRuntime.current = runtime;
      setCalibrationRuntime(runtime);
      setStage("calibration");
      store.save({ route, stage: "calibration", displayedProgressMeters: 0 });
    } catch (error) {
      returnToPreview(
        error instanceof Error ? error.message : "Re-alignment could not start."
      );
    }
  };

  const endWalk = () => {
    releaseSession();
    releaseCalibrationRuntime();
    releaseGrant();
    store.clear();
    setRoute(undefined);
    setPreparedRoute(undefined);
    setCalibration(undefined);
    setRuntimeSnapshot(undefined);
    setSelectedDestination(undefined);
    setCompatibilityMessage(undefined);
    setStage("search");
  };

  if (
    stage === "navigating" &&
    route &&
    preparedRoute &&
    grant &&
    calibration &&
    runtimeSnapshot
  ) {
    const hudNavigation = dismissedOffRoute
      ? { ...runtimeSnapshot.navigation, offRoute: false }
      : runtimeSnapshot.navigation;
    return (
      <main className="navigation-shell">
        <UpdatePrompt />
        <ArViewport
          stream={grant.stream}
          route={preparedRoute.groundRoute}
          calibration={calibration}
          pose={runtimeSnapshot.pose}
          {...(backendFactory ? { backendFactory } : {})}
        />
        <NavigationHud
          navigation={hudNavigation}
          onExit={endWalk}
          onRealign={realign}
          onKeepRoute={() => setDismissedOffRoute(true)}
          onRecalculate={() =>
            returnToPreview("Route recalculation is ready from the preview screen.")
          }
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <UpdatePrompt />
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
        <p>Stay aware of traffic and your surroundings. Never use while driving.</p>
      </aside>

      {stage === "arrived" && route ? (
        <ArrivalScreen destinationName={route.destination.name} onDone={endWalk} />
      ) : stage === "calibration" && route && grant && preparedRoute && calibrationRuntime ? (
        <CalibrationScreen
          feed={calibrationRuntime.feed}
          screenPointToGround={calibrationRuntime.screenPointToGround}
          routeNearPoint={preparedRoute.routeNearPoint}
          intrinsics={calibrationRuntime.intrinsics}
          imageToScreen={calibrationRuntime.imageToScreen}
          onLock={startNavigation}
          onBack={() => returnToPreview()}
          stream={grant.stream}
        />
      ) : stage === "permissions" && route ? (
        <PermissionScreen
          requestAccess={requestAccess}
          onReady={startCalibration}
          onBack={() => setStage("preview")}
        />
      ) : stage === "preview" && route ? (
        <>
          {compatibilityMessage ? (
            <aside className="route-error" role="alert">
              <p>{compatibilityMessage}</p>
            </aside>
          ) : null}
          <RoutePreview
            route={route}
            mapAdapter={mapAdapter}
            onStart={() => setStage("permissions")}
            onBack={() => {
              store.clear();
              setRoute(undefined);
              setStage("search");
            }}
          />
        </>
      ) : (
        <>
          <SearchScreen
            destinationAdapter={destinationAdapter}
            requestLocation={requestLocation}
            onLocation={chooseOrigin}
            onDestination={chooseDestination}
            origin={originFix?.point}
          />
          {routeLoading ? (
            <p className="route-request-status" role="status">
              Calculating your walking route…
            </p>
          ) : null}
          {routeError ? (
            <aside className="route-error" role="alert">
              <p>{routeError}</p>
              {originFix && selectedDestination ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => loadRoute(originFix, selectedDestination)}
                >
                  Retry route
                </button>
              ) : null}
            </aside>
          ) : null}
        </>
      )}
    </main>
  );
}

function createDefaultSession(
  input: AppNavigationSessionInput
): NavigationSessionLike {
  const { grant, ...options } = input;
  return new NavigationSession({
    ...options,
    adapters: createBrowserNavigationAdapters(grant.stream, input.calibration)
  });
}

function prepareRoute(route: RoutePlan, fix: LocationFix): PreparedRoute {
  const localRoute = decodeAndSampleRoute(route.encodedPolyline, 2.5);
  const groundRoute = localRoute.map<RouteGroundPoint>((point) => ({
    rightMeters: point.eastMeters,
    upMeters: point.upMeters,
    forwardMeters: point.northMeters,
    routeDistanceMeters: point.routeDistanceMeters
  }));
  const match = nearestRouteProgress(toEnu(fix.point, route.origin), localRoute);
  const routeNearPoint = groundRoute.reduce((nearest, point) =>
    Math.abs(point.routeDistanceMeters - match.progressMeters) <
    Math.abs(nearest.routeDistanceMeters - match.progressMeters)
      ? point
      : nearest
  );
  return { localRoute, groundRoute, routeNearPoint };
}

function createInitialSnapshot(
  route: RoutePlan,
  calibration: GroundCalibration
): NavigationRuntimeSnapshot {
  const progress = calibration.calibrationRouteDistanceMeters;
  const timestampMs = calibration.lockedAtMs ?? Date.now();
  return {
    pose: new PoseFusion(calibration).snapshot(timestampMs),
    navigation: {
      routeProgressMeters: progress,
      acceptedGpsProgressMeters: progress,
      remainingDistanceMeters: Math.max(0, route.distanceMeters - progress),
      nextManeuver: selectNextManeuver(route.steps, progress),
      offRoute: false,
      trackingQuality: INITIAL_QUALITY,
      arrived: false,
      realignRequired: false,
      timestampMs
    }
  };
}

function safeSessionStore(): SessionStore {
  try {
    return createSessionStore();
  } catch {
    return {
      load: () => null,
      save: () => undefined,
      clear: () => undefined
    };
  }
}
