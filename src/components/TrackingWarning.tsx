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
        <strong>{needsRealign ? "Alignment needs a fresh anchor" : "Recovering alignment"}</strong>
        <p>
          {needsRealign
            ? "Point along the path and tap the ground once to re-align."
            : "Keep the path in view. Markers are approximate while tracking recovers."}
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
