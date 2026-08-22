export function isSafeStaticRequest(
  request: Request,
  appOrigin: string
): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== appOrigin) return false;
  if (/^\/(?:api|camera|location)(?:\/|$)/i.test(url.pathname)) return false;
  return (
    request.mode === "navigate" ||
    ["script", "style", "image", "font", "manifest", "worker"].includes(
      request.destination
    )
  );
}
