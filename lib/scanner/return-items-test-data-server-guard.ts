import { refFromSupabaseUrl } from "@/lib/staging-project-ref";
import {
  RETURN_ITEMS_PRODUCTION_SUPABASE_REF,
  isReturnItemTestDataMarker,
  type ReturnItemMarkerFields,
} from "@/lib/scanner/return-items-test-data-guard";

function normMarker(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isProductionSupabaseRef(ref: string | null | undefined): boolean {
  return normMarker(ref) === RETURN_ITEMS_PRODUCTION_SUPABASE_REF;
}

function supabaseProjectRefFromEnv(): string | null {
  const url =
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim() ||
    (process.env.SUPABASE_URL ?? "").trim();
  return refFromSupabaseUrl(url);
}

/** Production runtime: NODE_ENV=production or Supabase URL targets original ref. */
function isProductionAppRuntime(): boolean {
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  return isProductionSupabaseRef(supabaseProjectRefFromEnv());
}

/**
 * Server-only insert guard: blocks known test/parity markers from persisting in production.
 * No-op in non-production runtimes.
 */
export function assertCanInsertReturnItemAgainstTestMarkers(fields: ReturnItemMarkerFields): void {
  if (!isProductionAppRuntime()) return;
  if (!isReturnItemTestDataMarker(fields)) return;
  throw new Error(
    "Test/parity return_items markers (e.g. box-slip-alloc-parity-*) are blocked in production.",
  );
}

/** Backward-compatible alias while imports migrate. */
export const assertReturnItemInsertNotTestDataInProduction =
  assertCanInsertReturnItemAgainstTestMarkers;
