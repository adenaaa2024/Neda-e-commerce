"use server";

import { supabaseServer } from "@/lib/supabase-server";
import { resolveTenantListScope, type TenantQueryOpts } from "@/lib/server-tenant";
import { isUuidString } from "@/lib/uuid";

export type ClaimCaseListRow = {
  id: string;
  status: string;
  scanner_issue_type: string | null;
  primary_return_item_id: string | null;
  created_at: string;
  claim_submission_id: string | null;
  submission_report_url: string | null;
};

export async function listClaimCasesForOrganization(
  tenant?: TenantQueryOpts,
  opts?: { status?: string[]; limit?: number },
): Promise<{ ok: boolean; rows: ClaimCaseListRow[]; error?: string }> {
  try {
    const scope = await resolveTenantListScope(tenant);
    if (scope.mode !== "single") {
      return { ok: false, rows: [], error: "Select a single organization." };
    }

    let q = supabaseServer
      .from("claim_cases")
      .select(
        "id, status, scanner_issue_type, primary_return_item_id, created_at, metadata",
      )
      .eq("organization_id", scope.organizationId)
      .order("created_at", { ascending: false })
      .limit(opts?.limit ?? 100);

    if (opts?.status?.length) q = q.in("status", opts.status);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows: ClaimCaseListRow[] = (data ?? []).map((r) => {
      const meta = (r as { metadata?: Record<string, unknown> }).metadata ?? {};
      const subId = String(meta.claim_submission_id ?? "").trim() || null;
      return {
        id: String((r as { id: string }).id),
        status: String((r as { status: string }).status),
        scanner_issue_type: (r as { scanner_issue_type: string | null }).scanner_issue_type,
        primary_return_item_id: (r as { primary_return_item_id: string | null }).primary_return_item_id,
        created_at: String((r as { created_at: string }).created_at),
        claim_submission_id: subId && isUuidString(subId) ? subId : null,
        submission_report_url: null,
      };
    });

    const subIds = rows.map((r) => r.claim_submission_id).filter((id): id is string => !!id);
    if (subIds.length) {
      const { data: subs } = await supabaseServer
        .from("claim_submissions")
        .select("id, report_url")
        .in("id", subIds);
      const byId = new Map((subs ?? []).map((s) => [(s as { id: string }).id, (s as { report_url: string | null }).report_url]));
      for (const row of rows) {
        if (row.claim_submission_id) {
          row.submission_report_url = byId.get(row.claim_submission_id) ?? null;
        }
      }
    }

    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      error: e instanceof Error ? e.message : "Failed to list claim cases.",
    };
  }
}
