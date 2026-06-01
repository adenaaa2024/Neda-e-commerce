/**
 * Guards for scripts that insert or mutate `return_items` (smoke / parity / repair).
 * Refuses production Supabase and requires explicit non-production env markers.
 */
import {
  RETURN_ITEMS_PRODUCTION_SUPABASE_REF,
  RETURN_ITEMS_STAGING_SUPABASE_REF,
} from "@/lib/scanner/return-items-test-data-guard";
import {
  assertStagingSupabaseUrl,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "@/lib/staging-project-ref";

export const DEFAULT_SCANNER_SMOKE_FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";

export type ScriptReturnItemsWriteGuardResult = {
  stagingRef: string;
  supabaseUrl: string;
  testPackageId: string;
};

function isProductionSupabaseRef(ref: string | null | undefined): boolean {
  return String(ref ?? "").trim().toLowerCase() === RETURN_ITEMS_PRODUCTION_SUPABASE_REF;
}

function scriptStagingEnvOpen(): { ok: true } | { ok: false; reason: string } {
  const markers = [
    process.env.SUPABASE_ENV,
    process.env.APP_ENV,
    process.env.NEXT_PUBLIC_ENV,
    process.env.ENVIRONMENT,
    process.env.VERCEL_ENV,
    process.env.NODE_ENV,
  ]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .filter(Boolean);

  if (markers.some((m) => /^(dev|development|staging|preview|local|test)$/.test(m))) {
    return { ok: true };
  }

  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (ref === RETURN_ITEMS_STAGING_SUPABASE_REF) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      "Refuse script return_items writes unless SUPABASE_ENV/APP_ENV/NEXT_PUBLIC_ENV indicates dev|staging|test, or NEXT_PUBLIC_SUPABASE_URL targets staging.",
  };
}

/**
 * Call at the top of any script that inserts `return_items`.
 * Requires staging Supabase URL, blocks production ref, and resolves an isolated test package id.
 */
export function assertScriptReturnItemsWriteAllowed(options?: {
  testPackageIdEnv?: string;
  defaultTestPackageId?: string;
}): ScriptReturnItemsWriteGuardResult {
  loadEnvLocalIntoProcess();

  const envGate = scriptStagingEnvOpen();
  if (!envGate.ok) {
    throw new Error(`BLOCKED: ${envGate.reason}`);
  }

  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (!supabaseUrl) {
    throw new Error("BLOCKED: NEXT_PUBLIC_SUPABASE_URL is required for return_items script writes.");
  }

  assertStagingSupabaseUrl(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL");

  const ref = refFromSupabaseUrl(supabaseUrl);
  if (isProductionSupabaseRef(ref)) {
    throw new Error(
      `BLOCKED: return_items script writes refused against production ref ${RETURN_ITEMS_PRODUCTION_SUPABASE_REF}.`,
    );
  }
  if (ref !== RETURN_ITEMS_STAGING_SUPABASE_REF) {
    throw new Error(
      `BLOCKED: return_items script writes require staging ref ${RETURN_ITEMS_STAGING_SUPABASE_REF}, got ${ref ?? "missing"}.`,
    );
  }

  const envKey = options?.testPackageIdEnv ?? "TEST_PACKAGE_ID";
  const testPackageId =
    String(process.env[envKey] ?? "").trim() ||
    String(process.env.SCANNER_NEDA_06_FIXTURE_PACKAGE_ID ?? "").trim() ||
    String(options?.defaultTestPackageId ?? DEFAULT_SCANNER_SMOKE_FIXTURE_PACKAGE_ID).trim();

  if (!testPackageId) {
    throw new Error(`BLOCKED: set ${envKey} (or SCANNER_NEDA_06_FIXTURE_PACKAGE_ID) to an isolated test package UUID.`);
  }

  return { stagingRef: RETURN_ITEMS_STAGING_SUPABASE_REF, supabaseUrl, testPackageId };
}
