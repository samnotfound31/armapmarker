import type { RoutePlan } from "../domain/types";

const STORAGE_KEY = "ar-walking-navigation:active";
const STORAGE_VERSION = 1;

export type PersistedNavigationStage = "preview" | "calibration" | "navigating";

export type PersistedSession = {
  route: RoutePlan;
  stage: PersistedNavigationStage;
  displayedProgressMeters: number;
};

export type SessionStore = {
  load(): PersistedSession | null;
  save(session: PersistedSession): void;
  clear(): void;
};

export function createSessionStore(storage: Storage = sessionStorage): SessionStore {
  return {
    load() {
      const serialized = storage.getItem(STORAGE_KEY);
      if (!serialized) return null;
      try {
        const value: unknown = JSON.parse(serialized);
        return parsePersistedSession(value);
      } catch {
        return null;
      }
    },
    save(session) {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: STORAGE_VERSION,
          route: session.route,
          stage: session.stage,
          displayedProgressMeters: Math.max(0, session.displayedProgressMeters)
        })
      );
    },
    clear() {
      storage.removeItem(STORAGE_KEY);
    }
  };
}

function parsePersistedSession(value: unknown): PersistedSession | null {
  if (!isRecord(value) || value.version !== STORAGE_VERSION) return null;
  if (!isRoutePlan(value.route)) return null;
  if (
    value.stage !== "preview" &&
    value.stage !== "calibration" &&
    value.stage !== "navigating"
  ) {
    return null;
  }
  if (
    typeof value.displayedProgressMeters !== "number" ||
    !Number.isFinite(value.displayedProgressMeters) ||
    value.displayedProgressMeters < 0
  ) {
    return null;
  }
  return {
    route: value.route,
    stage: value.stage,
    displayedProgressMeters: value.displayedProgressMeters
  };
}

function isRoutePlan(value: unknown): value is RoutePlan {
  if (!isRecord(value)) return false;
  return (
    isGeoPoint(value.origin) &&
    isRecord(value.destination) &&
    isGeoPoint(value.destination) &&
    typeof value.destination.name === "string" &&
    (value.destination.placeId === undefined ||
      typeof value.destination.placeId === "string") &&
    typeof value.encodedPolyline === "string" &&
    isFiniteNonNegative(value.distanceMeters) &&
    isFiniteNonNegative(value.durationSeconds) &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step) =>
        isRecord(step) &&
        typeof step.instruction === "string" &&
        typeof step.maneuver === "string" &&
        isFiniteNonNegative(step.distanceMeters) &&
        typeof step.polyline === "string"
    )
  );
}

function isGeoPoint(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.lat === "number" &&
    Number.isFinite(value.lat) &&
    typeof value.lng === "number" &&
    Number.isFinite(value.lng)
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
