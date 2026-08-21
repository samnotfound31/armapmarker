import { describe, expect, it } from "vitest";
import type { RoutePlan } from "../domain/types";
import { createSessionStore } from "./sessionStore";

describe("sessionStore", () => {
  it("restores only the active route and non-sensitive navigation state", () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    store.save({
      route: route(),
      stage: "preview",
      displayedProgressMeters: 18
    });

    expect(store.load()).toEqual({
      route: route(),
      stage: "preview",
      displayedProgressMeters: 18
    });
    const serialized = storage.getItem("ar-walking-navigation:active");
    expect(serialized).not.toMatch(/frame|feature|homograph|locationHistory|accuracyMeters/i);
  });

  it("ignores corrupt or version-incompatible data and clears on end", () => {
    const storage = memoryStorage();
    storage.setItem("ar-walking-navigation:active", "not json");
    const store = createSessionStore(storage);
    expect(store.load()).toBeNull();

    store.save({ route: route(), stage: "navigating", displayedProgressMeters: 4 });
    store.clear();
    expect(store.load()).toBeNull();
  });
});

function route(): RoutePlan {
  return {
    origin: { lat: 22.57, lng: 88.36 },
    destination: { lat: 22.571, lng: 88.36, name: "Museum" },
    encodedPolyline: "encoded",
    distanceMeters: 100,
    durationSeconds: 80,
    steps: [
      { instruction: "Continue", maneuver: "STRAIGHT", distanceMeters: 100, polyline: "" }
    ]
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
