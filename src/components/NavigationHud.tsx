import type { NavigationSnapshot } from "../navigation/navigationEngine";
import { TrackingWarning } from "./TrackingWarning";

type NavigationHudProps = {
  navigation: NavigationSnapshot;
  onExit: () => void;
  onRealign: () => void;
  onRecalculate: () => void;
  onKeepRoute: () => void;
};

export function NavigationHud({
  navigation,
  onExit,
  onRealign,
  onRecalculate,
  onKeepRoute
}: NavigationHudProps) {
  const maneuver = navigation.nextManeuver;
  return (
    <div className="navigation-hud">
      <header className="maneuver-card">
        <div className="maneuver-icon" aria-hidden="true">
          {maneuverIcon(maneuver?.maneuver)}
        </div>
        <div>
          <p className="maneuver-distance">
            {maneuver ? formatDistance(maneuver.distanceToManeuverMeters) : "Now"}
          </p>
          <h2>{maneuver?.instruction ?? "Continue to destination"}</h2>
          <p>{formatDistance(navigation.remainingDistanceMeters)} remaining</p>
        </div>
        <button type="button" className="hud-exit" onClick={onExit}>
          Exit
        </button>
      </header>

      <p className={`tracking-chip is-${navigation.trackingQuality.state}`}>
        Tracking {navigation.trackingQuality.state}
      </p>

      <TrackingWarning
        quality={navigation.trackingQuality}
        realignRequired={navigation.realignRequired}
        onRealign={onRealign}
      />

      {navigation.offRoute ? (
        <aside className="off-route-warning" role="alert">
          <strong>You appear to be off the walking route.</strong>
          <div>
            <button type="button" onClick={onRecalculate}>
              Recalculate
            </button>
            <button type="button" onClick={onKeepRoute}>
              Keep current route
            </button>
          </div>
        </aside>
      ) : null}

      <p className="walking-safety-label">Walking only · Stay aware of traffic</p>
    </div>
  );
}

function maneuverIcon(maneuver?: string): string {
  if (maneuver?.includes("LEFT")) return "↰";
  if (maneuver?.includes("RIGHT")) return "↱";
  if (maneuver?.includes("UTURN")) return "↶";
  return "↑";
}

function formatDistance(distanceMeters: number): string {
  if (distanceMeters < 1_000) return `${Math.max(0, Math.round(distanceMeters))} m`;
  return `${(distanceMeters / 1_000).toFixed(1)} km`;
}
