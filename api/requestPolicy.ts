export type ClientRateLimiter = {
  check(
    clientId: string,
    nowMs: number
  ): { allowed: boolean; retryAfterSeconds: number };
};

export type RateLimiterConfig = {
  limit: number;
  windowMs: number;
  maxClients: number;
};

const DEFAULT_RATE_LIMIT: Readonly<RateLimiterConfig> = {
  limit: 20,
  windowMs: 60_000,
  maxClients: 10_000
};

export function createClientRateLimiter(
  config: Readonly<RateLimiterConfig> = DEFAULT_RATE_LIMIT
): ClientRateLimiter {
  if (config.limit < 1 || config.windowMs < 1 || config.maxClients < 1) {
    throw new RangeError("Rate-limit configuration must be positive.");
  }
  const clients = new Map<string, { windowStartedAtMs: number; count: number }>();
  return {
    check(clientId, nowMs) {
      for (const [id, entry] of clients) {
        if (nowMs - entry.windowStartedAtMs >= config.windowMs) {
          clients.delete(id);
        }
      }
      let entry = clients.get(clientId);
      if (!entry) {
        while (clients.size >= config.maxClients) {
          const oldest = clients.keys().next().value as string | undefined;
          if (!oldest) break;
          clients.delete(oldest);
        }
        entry = { windowStartedAtMs: nowMs, count: 0 };
        clients.set(clientId, entry);
      }
      entry.count += 1;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (entry.windowStartedAtMs + config.windowMs - nowMs) / 1000
        )
      );
      return {
        allowed: entry.count <= config.limit,
        retryAfterSeconds
      };
    }
  };
}

export function trustedClientId(request: Request): string | null {
  const value =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-real-ip");
  if (!value || value.length > 64 || value.includes(",")) return null;
  const normalized = value.trim();
  return /^[0-9a-f:.]+$/i.test(normalized) ? normalized : null;
}
