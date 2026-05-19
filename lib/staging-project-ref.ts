/**
 * Resolve staging Supabase project ref from env / approval (NEXT-ENV-05B).
 * Does not read or print secrets.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STAGING_REGISTRATION_APPROVAL = join(
  process.cwd(),
  ".cursor/operator-approvals/staging-registration-01-approval.md",
);

const REF_RE = /^[a-z]{20}$/;

export function refFromSupabaseUrl(url: string): string | null {
  const m = url.trim().match(/https:\/\/([a-z]{20})\.supabase\.co/i);
  return m?.[1]?.toLowerCase() ?? null;
}

export function loadEnvLocalIntoProcess(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function stagingRefFromApprovalFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf8").match(/STAGING_PROJECT_REF\s*=\s*([a-z]{20})/i);
  const ref = m?.[1]?.toLowerCase();
  return ref && REF_RE.test(ref) ? ref : null;
}

/** Staging clone ref for smoke/verify guards (env `STAGING_PROJECT_REF` or URL-derived). */
export function getStagingProjectRef(options?: { loadEnv?: boolean }): string {
  if (options?.loadEnv !== false) loadEnvLocalIntoProcess();

  const fromEnv = process.env.STAGING_PROJECT_REF?.trim().toLowerCase();
  if (fromEnv && REF_RE.test(fromEnv)) return fromEnv;

  for (const key of ["STAGING_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const) {
    const ref = refFromSupabaseUrl(process.env[key] ?? "");
    if (ref) return ref;
  }

  const fromApproval =
    stagingRefFromApprovalFile(STAGING_REGISTRATION_APPROVAL) ??
    stagingRefFromApprovalFile(
      join(process.cwd(), ".cursor/operator-approvals/staging-clone-01-approval.md"),
    );
  if (fromApproval) return fromApproval;

  throw new Error(
    "STAGING_PROJECT_REF unset — set in .env.local, STAGING_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL, or staging-registration-01-approval.md",
  );
}

export function supabaseUrlMatchesStagingRef(url: string, stagingRef?: string): boolean {
  const ref = stagingRef ?? getStagingProjectRef();
  if (!url.trim()) return false;
  return url.includes(ref);
}

export function assertStagingSupabaseUrl(supabaseUrl: string, label = "Supabase URL"): void {
  const ref = getStagingProjectRef();
  if (!supabaseUrlMatchesStagingRef(supabaseUrl, ref)) {
    throw new Error(`BLOCKED: ${label} must target staging project ${ref}.`);
  }
}
