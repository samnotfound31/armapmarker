import type { GeoPoint } from "../domain/types";

export type LocationFix = {
  point: GeoPoint;
  accuracyMeters: number;
  timestampMs: number;
};

export type LocationErrorCode =
  | "unsupported"
  | "denied"
  | "unavailable"
  | "timeout"
  | "inaccurate";

export class LocationAccessError extends Error {
  public readonly name = "LocationAccessError";

  public constructor(
    public readonly code: LocationErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function requestCurrentLocation(
  signal: AbortSignal,
  geolocation: Geolocation | undefined = globalThis.navigator?.geolocation,
  maximumAccuracyMeters = 25
): Promise<LocationFix> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  if (!geolocation) {
    return Promise.reject(
      new LocationAccessError(
        "unsupported",
        "This browser does not provide location access."
      )
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(createAbortError()));

    signal.addEventListener("abort", onAbort, { once: true });
    geolocation.getCurrentPosition(
      (position) => {
        if (position.coords.accuracy > maximumAccuracyMeters) {
          finish(() =>
            reject(
              new LocationAccessError(
                "inaccurate",
                "Improving location accuracy. Move outdoors and try again."
              )
            )
          );
          return;
        }

        const point: GeoPoint = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        if (position.coords.altitude !== null) {
          point.altitudeMeters = position.coords.altitude;
        }
        finish(() =>
          resolve({
            point,
            accuracyMeters: position.coords.accuracy,
            timestampMs: position.timestamp
          })
        );
      },
      (error) => finish(() => reject(mapGeolocationError(error))),
      {
        enableHighAccuracy: true,
        timeout: 5_000,
        maximumAge: 1_000
      }
    );
  });
}

function mapGeolocationError(error: GeolocationPositionError): LocationAccessError {
  switch (error.code) {
    case 1:
      return new LocationAccessError(
        "denied",
        "Location permission was denied."
      );
    case 3:
      return new LocationAccessError(
        "timeout",
        "Location took too long. Move outdoors and try again."
      );
    default:
      return new LocationAccessError(
        "unavailable",
        "Your current location is unavailable."
      );
  }
}

function createAbortError(): DOMException {
  return new DOMException("Location request cancelled.", "AbortError");
}
