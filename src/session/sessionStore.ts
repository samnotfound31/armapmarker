import type { RoutePlan } from "../domain/types";

const SESSION_STORAGE_KEY = "ar-walking-navigation:active";
const PROGRESS_STORAGE_KEY = "ar-walking-navigation:progress";
const SESSION_STORAGE_VERSION = 2;
const LEGACY_SESSION_STORAGE_VERSION = 1;
const PROGRESS_STORAGE_VERSION = 1;

export type PersistedNavigationStage = "preview" | "calibration" | "navigating";

export type PersistedSession = {
  route: RoutePlan;
  stage: PersistedNavigationStage;
  displayedProgressMeters: number;
};

export type SessionStore = {
  load(): PersistedSession | null;
  saveSession(session: PersistedSession): void;
  saveProgress(displayedProgressMeters: number): void;
  clear(): void;
};

export function createSessionStore(storage: Storage = sessionStorage): SessionStore {
  return {
    load() {
      const serialized = storage.getItem(SESSION_STORAGE_KEY);
      if (!serialized) return null;
      try {
        const value: unknown = JSON.parse(serialized);
        const session = parsePersistedSession(value);
        if (!session) return null;
        const progress = parsePersistedProgress(
          storage.getItem(PROGRESS_STORAGE_KEY)
        );
        return {
          ...session,
          displayedProgressMeters:
            progress ?? session.displayedProgressMeters
        };
      } catch {
        return null;
      }
    },
    saveSession(session) {
      storage.removeItem(PROGRESS_STORAGE_KEY);
      storage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          version: SESSION_STORAGE_VERSION,
          route: session.route,
          stage: session.stage,
          displayedProgressMeters: normalizeProgress(
            session.displayedProgressMeters
          )
        })
      );
    },
    saveProgress(displayedProgressMeters) {
      storage.setItem(
        PROGRESS_STORAGE_KEY,
        JSON.stringify({
          version: PROGRESS_STORAGE_VERSION,
          displayedProgressMeters: normalizeProgress(displayedProgressMeters)
        })
      );
    },
    clear() {
      storage.removeItem(SESSION_STORAGE_KEY);
      storage.removeItem(PROGRESS_STORAGE_KEY);
    }
  };
}

function parsePersistedSession(value: unknown): PersistedSession | null {
  if (
    !isRecord(value) ||
    (value.version !== SESSION_STORAGE_VERSION &&
      value.version !== LEGACY_SESSION_STORAGE_VERSION)
  ) {
    return null;
  }
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

function parsePersistedProgress(serialized: string | null): number | null {
  if (!serialized) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.version !== PROGRESS_STORAGE_VERSION ||
      !isFiniteNonNegative(value.displayedProgressMeters)
    ) {
      return null;
    }
    return value.displayedProgressMeters;
  } catch {
    return null;
  }
}

function normalizeProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
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
