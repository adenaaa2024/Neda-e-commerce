/**
 * Read-only org/store guards for claim surfaces (service-role server code).
 * NEXT-CLAIM-24 — centralize validation used by inbox APIs and claim_submissions paths.
 */
import { supabaseServer } from "./supabase-server";
import { isUuidString } from "./uuid";

export async function assertStoreBelongsToOrganization(
  organizationId: string,
  storeId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { data, error } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "Store not found for this organization.", status: 403 };
  return { ok: true };
}

/** Ensures a submission row exists for the tenant before mutating or uploading artifacts. */
export async function assertClaimSubmissionBelongsToOrganization(
  submissionId: string,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUuidString(submissionId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid submission or organization id." };
  }
  const { data, error } = await supabaseServer
    .from("claim_submissions")
    .select("id")
    .eq("id", submissionId)
    .or(`organization_id.eq.${organizationId},company_id.eq.${organizationId}`)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Submission not found for this organization." };
  return { ok: true };
}

/** Load store + status for a submission in this tenant (organization / company id). */
export async function fetchClaimSubmissionScopeForOrganization(
  submissionId: string,
  organizationId: string,
): Promise<
  | { ok: true; store_id: string | null; status: string | null }
  | { ok: false; error: string; status: number }
> {
  if (!isUuidString(submissionId) || !isUuidString(organizationId)) {
    return { ok: false, error: "Invalid submission or organization id.", status: 400 };
  }
  const { data, error } = await supabaseServer
    .from("claim_submissions")
    .select("store_id, status")
    .eq("id", submissionId)
    .or(`organization_id.eq.${organizationId},company_id.eq.${organizationId}`)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "Submission not found for this organization.", status: 404 };
  const row = data as { store_id?: string | null; status?: string | null };
  return { ok: true, store_id: row.store_id ?? null, status: row.status ?? null };
}
