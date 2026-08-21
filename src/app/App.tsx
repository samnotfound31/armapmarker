export function App() {
  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="app-title">
        <p className="eyebrow">Outdoor walking navigation</p>
        <h1 id="app-title">Walk with AR</h1>
        <p className="hero-copy">
          Search for a destination, then follow bright route markers placed on
          the road through your camera.
        </p>
      </section>

      <aside className="safety-note" aria-label="Safety notice">
        <span aria-hidden="true">!</span>
        <p>
          Stay aware of traffic and your surroundings. Never use while driving.
        </p>
      </aside>

      <section className="search-card" aria-labelledby="search-title">
        <div>
          <p className="step-label">Step 1</p>
          <h2 id="search-title">Where are you walking?</h2>
        </div>

        <label htmlFor="destination">Destination</label>
        <input
          id="destination"
          name="destination"
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          placeholder="Search a place"
        />
      </section>
    </main>
  );
}
