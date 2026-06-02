import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS } from "@/lib/claim-drafts-api";
import {
  draftSourceTablesForIntakeFilter,
  isValidIntakeSourceFilter,
  type IntakeSourceFilter,
} from "@/lib/claim-intake-source-filter";
import { assertStoreBelongsToOrganization } from "@/lib/claim-org-scope";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

const MAX_LIMIT = 50;

/** Read-only claim_candidate_drafts preview (reimbursement / settlement intake). */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim() || null;
  const intakeSourceRaw = String(url.searchParams.get("intake_source") ?? "all").trim();
  const intakeSource: IntakeSourceFilter = isValidIntakeSourceFilter(intakeSourceRaw) ? intakeSourceRaw : "all";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "25", 10) || 25),
  );

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "organization_id must be a UUID." }, { status: 400 });
  }

  const access = await assertUserCanAccessOrganization(organizationId);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error },
      { status: access.error === "Not signed in." ? 401 : 403 },
    );
  }

  if (storeId) {
    if (!isUuidString(storeId)) {
      return NextResponse.json({ ok: false, error: "store_id must be a UUID when provided." }, { status: 400 });
    }
    const storeOk = await assertStoreBelongsToOrganization(organizationId, storeId);
    if (!storeOk.ok) {
      return NextResponse.json({ ok: false, error: storeOk.error }, { status: storeOk.status });
    }
  }

  const tables = draftSourceTablesForIntakeFilter(intakeSource);
  if (!tables?.length) {
    return NextResponse.json({ ok: true, items: [], intake_source: intakeSource });
  }

  let q = supabaseServer
    .from("claim_candidate_drafts")
    .select(CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS)
    .eq("organization_id", organizationId)
    .in("source_table", tables)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (storeId) q = q.eq("store_id", storeId);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const items = (data ?? []).map((row) => {
    const r = row as unknown as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      record_type: "claim_candidate_draft" as const,
      organization_id: r.organization_id,
      store_id: r.store_id,
      source_table: r.source_table,
      source_row_id: r.source_row_id,
      claim_family: r.claim_family,
      claim_reason: r.claim_reason,
      evidence_status: r.evidence_status,
      lifecycle_status: r.lifecycle_status,
      confidence_score: r.confidence_score,
      sku: r.sku,
      fnsku: r.fnsku,
      asin: r.asin,
      resolved_product_id: r.resolved_product_id,
      created_at: r.created_at,
      blocker_reasons: r.blocker_reasons,
      recommended_action: r.recommended_action,
    };
  });

  return NextResponse.json({
    ok: true,
    intake_source: intakeSource,
    items,
    note: "Draft-stage intake rows. Promote via explicit generator apply (env-gated); no marketplace submit.",
  });
}
