import type { NavigationSnapshot } from "../navigation/navigationEngine";
import { TrackingWarning } from "./TrackingWarning";

type NavigationHudProps = {
  navigation: NavigationSnapshot;
  onExit: () => void;
  onRealign: () => void;
  onRecalculate: () => void;
  onKeepRoute: () => void;
  direction?: "left" | "right" | "behind" | "ahead" | null;
};

export function NavigationHud({
  navigation,
  onExit,
  onRealign,
  onRecalculate,
  onKeepRoute,
  direction
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
        Visual tracking {navigation.trackingQuality.state}
      </p>

      <button type="button" className="alignment-adjust" onClick={onRealign}>Adjust alignment</button>

      <TrackingWarning
        quality={navigation.trackingQuality}
        realignRequired={navigation.realignRequired}
        onRealign={onRealign}
      />

      {direction && direction !== "ahead" && navigation.geographicState === "VALID" ?
        <p className="tracking-chip" aria-live="polite">{direction === "left" ? "← Route left" : direction === "right" ? "→ Route right" : "↶ Route behind — turn around"}</p> : null}

      {navigation.geographicState && navigation.geographicState !== "VALID" ? (
        <aside className="off-route-warning" role="alert">
          <strong>{geographicMessage(navigation.geographicState)}</strong>
          <p>AR tracers are paused until geographic guidance is reliable.</p>
          {direction === "behind" && navigation.geographicState === "WRONG_WAY" ? <p>↶ Route behind — turn around</p> : null}
          {(navigation.offRoute || ["OFF_ROUTE", "DEVIATED", "WRONG_WAY", "ROUTE_MATCH_UNCERTAIN"].includes(navigation.geographicState)) &&
            <button type="button" onClick={onRecalculate}>Recalculate route</button>}
        </aside>
      ) : navigation.offRoute ? (
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

function geographicMessage(state: NonNullable<NavigationSnapshot["geographicState"]>): string {
  switch(state) {
    case "LOCATION_UNCERTAIN": return "Location uncertain — wait for an accurate outdoor GPS fix.";
    case "HEADING_UNCERTAIN": return "Heading uncertain — move away from metal and calibrate the compass.";
    case "ROUTE_MATCH_UNCERTAIN": return "Route position uncertain — nearby paths cannot be distinguished.";
    case "WRONG_WAY": return "You are walking against the route.";
    case "DEVIATED": return "You appear to have missed the turn or left the intended path.";
    case "OFF_ROUTE": return "You appear to be off the walking route.";
    case "VALID": return "Geographic guidance ready.";
  }
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
