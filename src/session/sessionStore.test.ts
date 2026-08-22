import { describe, expect, it } from "vitest";
import type { RoutePlan } from "../domain/types";
import { createSessionStore } from "./sessionStore";

describe("sessionStore", () => {
  it("restores only the active route and non-sensitive navigation state", () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    store.saveSession({
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

  it("merges a small progress-only write without serializing the route again", () => {
    const writes: Array<{ key: string; value: string }> = [];
    const storage = memoryStorage(writes);
    const store = createSessionStore(storage);
    store.saveSession({
      route: route(),
      stage: "navigating",
      displayedProgressMeters: 4
    });
    writes.length = 0;

    store.saveProgress(18);

    expect(writes).toEqual([
      {
        key: "ar-walking-navigation:progress",
        value: JSON.stringify({ version: 1, displayedProgressMeters: 18 })
      }
    ]);
    expect(writes[0]?.value).not.toContain("encoded");
    expect(store.load()).toEqual({
      route: route(),
      stage: "navigating",
      displayedProgressMeters: 18
    });
  });

  it("loads the existing version-one session and resets stale progress on a stage write", () => {
    const storage = memoryStorage();
    storage.setItem(
      "ar-walking-navigation:active",
      JSON.stringify({
        version: 1,
        route: route(),
        stage: "navigating",
        displayedProgressMeters: 12
      })
    );
    const store = createSessionStore(storage);

    expect(store.load()?.displayedProgressMeters).toBe(12);
    store.saveProgress(30);
    expect(store.load()?.displayedProgressMeters).toBe(30);
    store.saveSession({
      route: route(),
      stage: "preview",
      displayedProgressMeters: 0
    });

    expect(store.load()?.displayedProgressMeters).toBe(0);
    expect(storage.getItem("ar-walking-navigation:progress")).toBeNull();
  });

  it("ignores corrupt or version-incompatible data and clears on end", () => {
    const storage = memoryStorage();
    storage.setItem("ar-walking-navigation:active", "not json");
    const store = createSessionStore(storage);
    expect(store.load()).toBeNull();

    store.saveSession({
      route: route(),
      stage: "navigating",
      displayedProgressMeters: 4
    });
    store.saveProgress(8);
    store.clear();
    expect(store.load()).toBeNull();
    expect(storage.getItem("ar-walking-navigation:progress")).toBeNull();
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

function memoryStorage(
  writes: Array<{ key: string; value: string }> = []
): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      writes.push({ key, value });
      values.set(key, value);
    }
  };
}
