/// <reference lib="webworker" />

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = "ar-walk-shell-v1";
const OFFLINE_SHELL = ["/", "/manifest.webmanifest", "/icons/app-icon.svg"];

worker.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_SHELL)));
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("ar-walk-shell-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => worker.clients.claim())
  );
});

worker.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void worker.skipWaiting();
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isSafeStaticRequest(request)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          void cacheResponse(request, response.clone());
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match("/"))!)
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      await cacheResponse(request, response.clone());
      return response;
    })
  );
});

function isSafeStaticRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return (
    request.mode === "navigate" ||
    ["script", "style", "image", "font", "manifest", "worker"].includes(
      request.destination
    )
  );
}

async function cacheResponse(request: Request, response: Response): Promise<void> {
  if (!response.ok || response.type !== "basic") return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}
