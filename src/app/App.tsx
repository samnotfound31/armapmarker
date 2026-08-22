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
  RoutePlan,
  TrackingQuality
} from "../domain/types";
import { stopMediaStream } from "../device/camera";
import { requestCurrentLocation, type LocationFix } from "../device/location";
import { requestArAccess, type ArAccessGrant } from "../device/permissions";
import { requestWalkingRoute, type WalkingRouteInput } from "../google/routeClient";
import { selectNextManeuver } from "../navigation/navigationEngine";
import { PoseFusion } from "../pose/PoseFusion";
import {
  prepareRoute,
  type PreparedRoute
} from "../route/prepareRoute";
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
  | "paused"
  | "arrived";

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
  const [calibrationGeneration, setCalibrationGeneration] = useState(0);
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
  const originFixRef = useRef<LocationFix | undefined>(originFix);
  const latestAcceptedFix = useRef<LocationFix | undefined>(originFix);
  const latestAcceptedProgressMeters = useRef(restored?.displayedProgressMeters ?? 0);
  const stageRef = useRef(stage);
  const routeRef = useRef(route);
  const visibilityInvalidated = useRef(false);
  stageRef.current = stage;
  routeRef.current = route;

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
      const currentOrigin = originFixRef.current;
      if (!currentOrigin) {
        setRouteError("Use your current location before calculating the route.");
        return;
      }
      loadRoute(currentOrigin, destination);
    },
    [loadRoute]
  );

  const chooseOrigin = useCallback(
    (fix: LocationFix) => {
      originFixRef.current = fix;
      latestAcceptedFix.current = fix;
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
      latestAcceptedFix.current = nextGrant.location;
      const nextPreparedRoute = prepareRoute(route, nextGrant.location);
      latestAcceptedProgressMeters.current =
        nextPreparedRoute.calibrationProgressMeters;
      const runtime = calibrationFactory(nextGrant);
      activeArGrant.current = nextGrant;
      activeCalibrationRuntime.current = runtime;
      setGrant(nextGrant);
      setPreparedRoute(nextPreparedRoute);
      setCalibrationRuntime(runtime);
      setStage("calibration");
      store.save({
        route,
        stage: "calibration",
        displayedProgressMeters: nextPreparedRoute.calibrationProgressMeters
      });
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
      enuOrigin: preparedRoute.enuOrigin,
      localRoute: preparedRoute.localRoute,
      groundRoute: preparedRoute.groundRoute,
      calibration: lockedCalibration,
      grant,
      onUpdate: (snapshot) => {
        latestAcceptedProgressMeters.current =
          snapshot.navigation.acceptedGpsProgressMeters;
        setRuntimeSnapshot(snapshot);
        if (!snapshot.navigation.offRoute) setDismissedOffRoute(false);
        store.save({
          route,
          stage: "navigating",
          displayedProgressMeters: snapshot.navigation.routeProgressMeters
        });
      },
      onLocationAccepted: (fix, progressMeters) => {
        latestAcceptedFix.current = fix;
        originFixRef.current = fix;
        latestAcceptedProgressMeters.current = progressMeters;
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
      const nextPreparedRoute = prepareRoute(
        route,
        latestAcceptedFix.current ?? grant.location
      );
      const runtime = calibrationFactory(grant);
      activeCalibrationRuntime.current = runtime;
      setPreparedRoute(nextPreparedRoute);
      setCalibrationRuntime(runtime);
      setStage("calibration");
      store.save({
        route,
        stage: "calibration",
        displayedProgressMeters: nextPreparedRoute.calibrationProgressMeters
      });
    } catch (error) {
      returnToPreview(
        error instanceof Error ? error.message : "Re-alignment could not start."
      );
    }
  };

  const recalculateRoute = () => {
    if (!route) return;
    const destination =
      selectedDestination ??
      (route.destination.placeId
        ? {
            placeId: route.destination.placeId,
            name: route.destination.name,
            formattedAddress: route.destination.name,
            location: route.destination
          }
        : undefined);
    if (!destination) {
      returnToPreview(
        "This restored route cannot be recalculated without selecting the destination again."
      );
      return;
    }

    releaseSession();
    releaseCalibrationRuntime();
    releaseGrant();
    setCalibration(undefined);
    setRuntimeSnapshot(undefined);
    setStage("preview");
    setCompatibilityMessage("Calculating a fresh walking route…");
    activeRouteRequest.current?.abort();
    const controller = new AbortController();
    activeRouteRequest.current = controller;
    void requestLocation(controller.signal)
      .then(async (fix) => {
        const nextRoute = await requestRoute(
          { origin: fix.point, destination },
          controller.signal
        );
        return { fix, nextRoute };
      })
      .then(({ fix, nextRoute }) => {
        if (controller.signal.aborted) return;
        latestAcceptedFix.current = fix;
        originFixRef.current = fix;
        latestAcceptedProgressMeters.current = 0;
        setOriginFix(fix);
        setSelectedDestination(destination);
        setRoute(nextRoute);
        setPreparedRoute(undefined);
        setCompatibilityMessage(undefined);
        store.save({
          route: nextRoute,
          stage: "preview",
          displayedProgressMeters: 0
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCompatibilityMessage(
          error instanceof Error
            ? error.message
            : "A fresh route could not be loaded."
        );
      });
  };

  useEffect(() => {
    const suspend = () => {
      if (
        stageRef.current !== "calibration" &&
        stageRef.current !== "navigating"
      ) {
        return;
      }
      const currentRoute = routeRef.current;
      stageRef.current = "paused";
      visibilityInvalidated.current = true;
      releaseSession();
      releaseCalibrationRuntime();
      setCalibration(undefined);
      setRuntimeSnapshot(undefined);
      setStage("paused");
      if (activeArGrant.current) {
        setMediaStreamEnabled(activeArGrant.current.stream, false);
      }
      if (currentRoute) {
        store.save({
          route: currentRoute,
          stage: "calibration",
          displayedProgressMeters: latestAcceptedProgressMeters.current
        });
      }
    };
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      if (!visibilityInvalidated.current) return;
      visibilityInvalidated.current = false;
      const currentGrant = activeArGrant.current;
      const currentRoute = routeRef.current;
      if (!currentGrant || !currentRoute) return;
      try {
        setMediaStreamEnabled(currentGrant.stream, true);
        const nextPreparedRoute = prepareRoute(
          currentRoute,
          latestAcceptedFix.current ?? currentGrant.location
        );
        const runtime = calibrationFactory(currentGrant);
        activeCalibrationRuntime.current = runtime;
        setPreparedRoute(nextPreparedRoute);
        setCalibrationRuntime(runtime);
        setCalibrationGeneration((generation) => generation + 1);
        stageRef.current = "calibration";
        setStage("calibration");
      } catch (error) {
        releaseGrant();
        setCompatibilityMessage(
          error instanceof Error
            ? error.message
            : "Re-alignment could not resume."
        );
        stageRef.current = "preview";
        setStage("preview");
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") suspend();
      else resume();
    };
    const onOrientationChange = () => {
      suspend();
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const orientation = globalThis.screen?.orientation;
    orientation?.addEventListener?.("change", onOrientationChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      orientation?.removeEventListener?.("change", onOrientationChange);
    };
  }, [calibrationFactory, store]);

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
          onRecalculate={recalculateRoute}
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
      ) : stage === "paused" ? (
        <section className="permission-card" aria-live="polite">
          <h2>Navigation paused</h2>
          <p>Return to the app to re-align the route before guidance resumes.</p>
        </section>
      ) : stage === "calibration" && route && grant && preparedRoute && calibrationRuntime ? (
        <CalibrationScreen
          key={calibrationGeneration}
          feed={calibrationRuntime.feed}
          screenPointToGround={calibrationRuntime.screenPointToGround}
          groundRoute={preparedRoute.groundRoute}
          calibrationProgressMeters={preparedRoute.calibrationProgressMeters}
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

function setMediaStreamEnabled(stream: MediaStream, enabled: boolean): void {
  for (const track of stream.getTracks()) track.enabled = enabled;
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
