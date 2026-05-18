/**
 * NEXT-CLAIM-FILING-AGENT-02 — HMAC verification for filing-request callbacks (no worker).
 * Signature: hex-encoded HMAC-SHA256 of `${timestampMs}.${rawBody}` using a shared secret.
 * Header `X-Filing-Request-Signature` must equal that hex string (no prefix).
 * Header `X-Filing-Request-Timestamp` is Unix epoch milliseconds as string.
 */

import { createHmac, timingSafeEqual } from "crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_SKEW_MS = 5 * 60 * 1000;

function hex(buf: Buffer): string {
  return buf.toString("hex");
}

export function computeFilingCallbackSignature(secret: string, timestampMs: number, rawBody: string): string {
  const msg = `${timestampMs}.${rawBody}`;
  return hex(createHmac("sha256", secret).update(msg, "utf8").digest());
}

/**
 * Prefer `CLAIM_FILING_CALLBACK_SECRET`. If absent, and `filing_callback_secret_ref` is an ENV-style
 * name (A–Z, 0–9, underscore), read `process.env[ref]`.
 */
export function resolveFilingCallbackHmacSecret(secretRef: string | null | undefined): string | null {
  const direct = process.env.CLAIM_FILING_CALLBACK_SECRET?.trim();
  if (direct) return direct;
  const ref = String(secretRef ?? "").trim();
  if (ref && /^[A-Z][A-Z0-9_]*$/.test(ref)) {
    const v = process.env[ref]?.trim();
    return v || null;
  }
  return null;
}

export function verifyFilingCallbackHmac(args: {
  readonly secret: string;
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
  readonly nowMs?: number;
}): { ok: true; timestampMs: number } | { ok: false; error: string; status: number } {
  const sigRaw = String(args.signatureHeader ?? "").trim();
  const tsRaw = String(args.timestampHeader ?? "").trim();
  if (!sigRaw || !tsRaw) {
    return { ok: false, error: "Missing X-Filing-Request-Signature or X-Filing-Request-Timestamp.", status: 401 };
  }
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, error: "Invalid X-Filing-Request-Timestamp.", status: 401 };
  }
  const now = args.nowMs ?? Date.now();
  if (Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, error: "Callback timestamp outside allowed skew.", status: 401 };
  }
  const expected = computeFilingCallbackSignature(args.secret, ts, args.rawBody);
  try {
    const a = Buffer.from(sigRaw, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: "Invalid callback signature.", status: 401 };
    }
  } catch {
    return { ok: false, error: "Invalid callback signature encoding.", status: 401 };
  }
  return { ok: true, timestampMs: ts };
}

export async function filingCallbackReplayNonceUsed(
  supabase: SupabaseClient,
  filingRequestId: string,
  replayNonce: string | null | undefined,
): Promise<boolean> {
  const n = String(replayNonce ?? "").trim();
  if (!n) return false;
  const { data, error } = await supabase
    .from("claim_filing_request_events")
    .select("payload")
    .eq("filing_request_id", filingRequestId)
    .eq("event_type", "callback_received")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return false;
  for (const row of data ?? []) {
    const p = (row as { payload?: unknown }).payload;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const v = (p as unknown as Record<string, unknown>).replay_nonce;
      if (typeof v === "string" && v === n) return true;
    }
  }
  return false;
}
