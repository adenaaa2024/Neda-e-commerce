import "server-only";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterMs(base: number): number {
  return Math.floor(base * (0.85 + Math.random() * 0.3));
}

function parseRetryAfterSeconds(h: string | null): number | null {
  if (!h) return null;
  const n = Number.parseInt(h.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 120) : null;
}

export type SpApiJsonFetchResult =
  | { ok: true; status: number; text: string; json: unknown | null; attempts: number }
  | { ok: false; status: number; text: string; json: unknown | null; attempts: number; lastTransient?: boolean };

/**
 * SP-API fetch with exponential backoff + jitter on 429 / 503.
 * Honors `Retry-After` when present (capped).
 */
export async function fetchSpApiJsonWithRetry(
  url: string,
  init: RequestInit,
  opts?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number },
): Promise<SpApiJsonFetchResult> {
  const maxAttempts = Math.max(1, Math.min(8, opts?.maxAttempts ?? 5));
  const baseDelayMs = Math.max(80, opts?.baseDelayMs ?? 400);
  const maxDelayMs = Math.max(baseDelayMs, opts?.maxDelayMs ?? 25_000);

  let lastText = "";
  let lastJson: unknown | null = null;
  let lastStatus = 0;
  let lastTransient = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { ...init, cache: "no-store" });
    lastStatus = res.status;
    lastText = await res.text().catch(() => "");
    lastJson = null;
    try {
      lastJson = lastText ? (JSON.parse(lastText) as unknown) : null;
    } catch {
      lastJson = null;
    }

    if (res.ok) {
      return { ok: true, status: res.status, text: lastText, json: lastJson, attempts: attempt };
    }

    const retryable = res.status === 429 || res.status === 503;
    lastTransient = retryable;
    if (!retryable || attempt === maxAttempts) {
      return {
        ok: false,
        status: res.status,
        text: lastText,
        json: lastJson,
        attempts: attempt,
        lastTransient: retryable,
      };
    }

    const ra = parseRetryAfterSeconds(res.headers.get("retry-after"));
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const wait = ra != null ? jitterMs(ra * 1000) : jitterMs(exp);
    await sleep(wait);
  }

  return {
    ok: false,
    status: lastStatus,
    text: lastText,
    json: lastJson,
    attempts: maxAttempts,
    lastTransient: lastTransient,
  };
}
