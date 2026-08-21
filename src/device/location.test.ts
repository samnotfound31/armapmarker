import { describe, expect, it, vi } from "vitest";
import { requestCurrentLocation } from "./location";

const accuratePosition = {
  coords: {
    latitude: 22.5726,
    longitude: 88.3639,
    altitude: null,
    accuracy: 9,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    toJSON: () => ({})
  },
  timestamp: 1000,
  toJSON: () => ({})
} satisfies GeolocationPosition;

describe("requestCurrentLocation", () => {
  it("returns an accurate user-initiated location fix", async () => {
    const geolocation = createGeolocation((success) => success(accuratePosition));

    await expect(
      requestCurrentLocation(new AbortController().signal, geolocation)
    ).resolves.toEqual({
      point: { lat: 22.5726, lng: 88.3639 },
      accuracyMeters: 9,
      timestampMs: 1000
    });
  });

  it("asks for a better fix when accuracy is worse than 25 metres", async () => {
    const geolocation = createGeolocation((success) =>
      success({
        ...accuratePosition,
        coords: { ...accuratePosition.coords, accuracy: 31 }
      })
    );

    await expect(
      requestCurrentLocation(new AbortController().signal, geolocation)
    ).rejects.toEqual(
      expect.objectContaining({
        name: "LocationAccessError",
        code: "inaccurate"
      })
    );
  });

  it("maps browser denial to a recovery-safe error", async () => {
    const geolocation = createGeolocation((_success, error) =>
      error({ code: 1, message: "browser detail" } as GeolocationPositionError)
    );

    await expect(
      requestCurrentLocation(new AbortController().signal, geolocation)
    ).rejects.toEqual(
      expect.objectContaining({
        name: "LocationAccessError",
        code: "denied",
        message: "Location permission was denied."
      })
    );
  });

  it("rejects an aborted request and ignores a late browser callback", async () => {
    let deliver: PositionCallback | undefined;
    const geolocation = createGeolocation((success) => {
      deliver = success;
    });
    const controller = new AbortController();
    const request = requestCurrentLocation(controller.signal, geolocation);

    controller.abort();
    deliver?.(accuratePosition);

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

function createGeolocation(
  getCurrentPosition: (
    success: PositionCallback,
    error: PositionErrorCallback,
    options?: PositionOptions
  ) => void
): Geolocation {
  return {
    getCurrentPosition: vi.fn(getCurrentPosition),
    watchPosition: vi.fn(),
    clearWatch: vi.fn()
  };
}
