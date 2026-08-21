import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/app.css";
import serviceWorkerUrl from "./sw.ts?worker&url";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root application mount point");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(serviceWorkerUrl, { type: "module" }).then(
    (registration) => {
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            window.dispatchEvent(
              new CustomEvent("ar-app-update-ready", { detail: registration })
            );
          }
        });
      });
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    }
  );
}
