type ArrivalScreenProps = {
  destinationName: string;
  onDone: () => void;
};

export function ArrivalScreen({ destinationName, onDone }: ArrivalScreenProps) {
  return (
    <section className="arrival-card" aria-labelledby="arrival-title">
      <span className="arrival-check" aria-hidden="true">✓</span>
      <p className="step-label">Destination reached</p>
      <h2 id="arrival-title">You arrived at {destinationName}</h2>
      <p>AR navigation has stopped and the camera is off.</p>
      <button type="button" className="primary-button" onClick={onDone}>
        End walk
      </button>
    </section>
  );
}
