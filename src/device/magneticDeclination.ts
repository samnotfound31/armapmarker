import geomagnetism from "geomagnetism";
import type { GeoPoint } from "../domain/types";

/** East-positive magnetic declination, degrees. Undefined means no valid model. */
export function magneticDeclinationForLocation(point: GeoPoint, epochMs: number): number | undefined {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || !Number.isFinite(epochMs) ||
      Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return undefined;
  try {
    const field = geomagnetism.model(new Date(epochMs)).point([point.lat, point.lng]);
    // WMM caution zones have insufficient horizontal field for compass guidance.
    return field.h > 6_000 && Number.isFinite(field.decl) ? field.decl : undefined;
  } catch {
    // An expired model cannot provide a validated true-north reference.
    return undefined;
  }
}
