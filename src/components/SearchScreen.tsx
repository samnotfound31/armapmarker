import { useEffect, useRef, useState } from "react";
import type { Destination, GeoPoint } from "../domain/types";
import type { LocationFix } from "../device/location";
import {
  loadGoogleLibraries,
  type GoogleLibraries
} from "../google/mapsLoader";

export type DestinationSearchCallbacks = {
  origin?: GeoPoint;
  getOrigin?: () => GeoPoint | undefined;
  onSelect: (destination: Destination) => void;
  onError: (message: string) => void;
  onQueryChange?: () => void;
};

export type DestinationSearchAdapter = {
  mount(
    host: HTMLElement,
    callbacks: DestinationSearchCallbacks
  ): (() => void) | Promise<() => void>;
};

type SearchScreenProps = {
  destinationAdapter: DestinationSearchAdapter;
  requestLocation: (signal: AbortSignal) => Promise<LocationFix>;
  onLocation: (fix: LocationFix) => void;
  onDestination: (destination: Destination) => void;
  origin?: GeoPoint;
};

type GoogleLibrariesLoader = (apiKey: string) => Promise<GoogleLibraries>;

export function createGoogleDestinationSearchAdapter(
  apiKey: string,
  loadLibraries: GoogleLibrariesLoader = loadGoogleLibraries
): DestinationSearchAdapter {
  return {
    async mount(host, callbacks) {
      const { places } = await loadLibraries(apiKey);
      const autocomplete = new places.PlaceAutocompleteElement();
      autocomplete.placeholder = "Search a place";
      autocomplete.description = "Destination search";
      if (callbacks.origin) {
        autocomplete.locationBias = {
          center: callbacks.origin,
          radius: 20_000
        };
        autocomplete.origin = callbacks.origin;
      }

      const selectPlace = async (
        event: google.maps.places.PlacePredictionSelectEvent
      ) => {
        try {
          const prediction = event.placePrediction;
          const place = prediction.toPlace();
          await place.fetchFields({
            fields: ["displayName", "formattedAddress", "location"]
          });
          if (!place.displayName || !place.formattedAddress || !place.location) {
            callbacks.onError("Google did not return enough detail for that place.");
            return;
          }
          callbacks.onSelect({
            placeId: prediction.placeId,
            name: place.displayName,
            formattedAddress: place.formattedAddress,
            location: {
              lat: place.location.lat(),
              lng: place.location.lng()
            }
          });
        } catch {
          callbacks.onError("Destination details could not be loaded. Try again.");
        }
      };
      const handleSelection: EventListener = (event) => {
        void selectPlace(
          event as google.maps.places.PlacePredictionSelectEvent
        );
      };
      const handleError = () =>
        callbacks.onError("Google destination search is unavailable. Try again.");

      autocomplete.addEventListener("gmp-select", handleSelection);
      autocomplete.addEventListener("gmp-error", handleError);
      host.append(autocomplete);

      return () => {
        autocomplete.removeEventListener("gmp-select", handleSelection);
        autocomplete.removeEventListener("gmp-error", handleError);
        autocomplete.remove();
      };
    }
  };
}

export function SearchScreen({
  destinationAdapter,
  requestLocation,
  onLocation,
  onDestination,
  origin
}: SearchScreenProps) {
  const destinationHost = useRef<HTMLDivElement>(null);
  const locationRequest = useRef<AbortController | null>(null);
  const onDestinationRef = useRef(onDestination);
  const originRef = useRef(origin);
  const [destinationReady, setDestinationReady] = useState(false);
  const [destinationError, setDestinationError] = useState<string>();
  const [locationStatus, setLocationStatus] = useState<
    "idle" | "requesting" | "ready"
  >(origin ? "ready" : "idle");
  const [locationAccuracy, setLocationAccuracy] = useState<number>();
  const [locationError, setLocationError] = useState<string>();

  onDestinationRef.current = onDestination;
  originRef.current = origin;

  useEffect(() => {
    const host = destinationHost.current;
    if (!host) return;

    let active = true;
    let dispose: (() => void) | undefined;
    setDestinationReady(false);
    setDestinationError(undefined);
    Promise.resolve(
      destinationAdapter.mount(host, {
        origin: originRef.current,
        getOrigin: () => originRef.current,
        onSelect: (destination) => onDestinationRef.current(destination),
        onError: setDestinationError,
        onQueryChange: () => setDestinationError(undefined)
      })
    )
      .then((mountedDispose) => {
        if (active) {
          dispose = mountedDispose;
          setDestinationReady(true);
        } else {
          mountedDispose();
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setDestinationError(
            error instanceof Error
              ? error.message
              : "Destination search could not be loaded."
          );
        }
      });

    return () => {
      active = false;
      dispose?.();
      host.replaceChildren();
    };
  }, [destinationAdapter]);

  useEffect(
    () => () => {
      locationRequest.current?.abort();
    },
    []
  );

  const useLocation = async () => {
    locationRequest.current?.abort();
    const controller = new AbortController();
    locationRequest.current = controller;
    setLocationStatus("requesting");
    setLocationError(undefined);
    try {
      const fix = await requestLocation(controller.signal);
      if (controller.signal.aborted) return;
      setLocationStatus("ready");
      setLocationAccuracy(fix.accuracyMeters);
      onLocation(fix);
    } catch (error) {
      if (controller.signal.aborted) return;
      setLocationStatus("idle");
      setLocationError(
        error instanceof Error ? error.message : "Location could not be loaded."
      );
    }
  };

  return (
    <section className="search-card" aria-labelledby="search-title">
      <div>
        <p className="step-label">Step 1</p>
        <h2 id="search-title">Where are you walking?</h2>
      </div>

      <div className="location-row">
        <button
          type="button"
          className="secondary-button"
          disabled={locationStatus === "requesting"}
          onClick={() => void useLocation()}
        >
          {locationStatus === "requesting"
            ? "Finding your location…"
            : "Use my location"}
        </button>
        {locationStatus === "ready" && (
          <p className="status-line" aria-live="polite">
            Location ready
            {locationAccuracy !== undefined
              ? ` · ${Math.round(locationAccuracy)} m accuracy`
              : ""}
          </p>
        )}
      </div>
      {locationError && <p role="alert">{locationError}</p>}

      <label htmlFor="destination-fallback">Destination</label>
      {!destinationReady && (
        <input
          id="destination-fallback"
          name="destination"
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          placeholder="Search a place"
        />
      )}
      <div ref={destinationHost} className="destination-host" />
      {destinationError && <p role="alert">{destinationError}</p>}
    </section>
  );
}
