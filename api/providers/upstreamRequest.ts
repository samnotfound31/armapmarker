export const HEIGIT_UPSTREAM_TIMEOUT_MS = 8_000;

export function createUpstreamRequestSignal(
  parentSignal: AbortSignal,
  timeoutMs = HEIGIT_UPSTREAM_TIMEOUT_MS
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  const timer = setTimeout(() => {
    controller.abort(new DOMException("HeiGIT request timed out.", "TimeoutError"));
  }, timeoutMs);

  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  };
}

export function safeRetryAfter(response: Response): string | undefined {
  const value = response.headers.get("Retry-After");
  if (!value || !/^\d+$/.test(value)) return undefined;
  return String(Math.min(Math.max(Number(value), 1), 3_600));
}
