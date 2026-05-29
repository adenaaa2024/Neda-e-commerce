import { NextResponse } from "next/server";

import { isJobType } from "@/lib/jobs/repository";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;

export function jobApiError(message: string, status = 400, code?: string): Response {
  return NextResponse.json({ ok: false, error: message, ...(code ? { code } : {}) }, { status });
}

export function jobApiBlocked(error: unknown): Response {
  const msg = error instanceof Error ? error.message : String(error);
  const status = msg.startsWith("BLOCKED:") || msg.includes("blocked") ? 403 : 500;
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export function parseUuidField(value: unknown, field: string): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!isUuidString(s)) return null;
  return s;
}

export function parseJobType(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!isJobType(s)) return null;
  return s;
}

export function parseIdempotencyKey(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s || s.length > 512) return null;
  return s;
}
