import type { TrackingQuality } from "../domain/types";

type TrackingWarningProps = {
  quality: TrackingQuality;
  realignRequired: boolean;
  onRealign: () => void;
};

export function TrackingWarning({
  quality,
  realignRequired,
  onRealign
}: TrackingWarningProps) {
  if (quality.state === "locked" && !realignRequired) return null;
  const needsRealign = quality.state === "realign" || realignRequired;
  return (
    <aside className="tracking-warning" role="alert">
      <div>
        <strong>{needsRealign ? "Route alignment drifted" : "Tracking is weak"}</strong>
        <p>
          {needsRealign
            ? "Stop walking and align the route to the road again."
            : "Move more slowly and keep textured road in view."}
        </p>
      </div>
      {needsRealign ? (
        <button type="button" onClick={onRealign}>
          Re-align
        </button>
      ) : null}
    </aside>
  );
}
