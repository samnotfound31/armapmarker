import { useEffect, useState } from "react";

export function UpdatePrompt() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();

  useEffect(() => {
    const onUpdate = (event: Event) => {
      setRegistration(
        (event as CustomEvent<ServiceWorkerRegistration>).detail
      );
    };
    window.addEventListener("ar-app-update-ready", onUpdate);
    return () => window.removeEventListener("ar-app-update-ready", onUpdate);
  }, []);

  if (!registration) return null;
  return (
    <aside className="update-prompt" role="status">
      <p>A safer, newer AR build is ready.</p>
      <button
        type="button"
        onClick={() => registration.waiting?.postMessage("SKIP_WAITING")}
      >
        Update now
      </button>
      <button type="button" onClick={() => setRegistration(undefined)}>
        Later
      </button>
    </aside>
  );
}
