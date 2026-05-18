import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import {
  claimInboxStr,
  fetchCandidateSourceContextMap,
  projectClaimCandidatesBatch,
} from "../../../../../lib/claim-inbox-projection";
import { getClaimInboxDetailSelect, getClaimInboxProductBadgeSelect } from "../../../../../lib/claim-inbox-schema";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../lib/uuid";

const STALE_REMOVALS_LINEAGE_MESSAGE =
  "This claim candidate points to an older Amazon removal source row that no longer exists in the current operational table. The system cannot safely auto-repair the source link.";

export async function GET(req: Request, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await ctx.params;
  if (!isUuidString(candidateId)) {
    return NextResponse.json({ error: "Invalid candidate id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const detailSelect = await getClaimInboxDetailSelect(supabaseServer);
  const { data: cand, error: cErr } = await supabaseServer
    .from("claim_candidates")
    .select(detailSelect)
    .eq("id", candidateId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
  if (!cand) return NextResponse.json({ error: "Candidate not found." }, { status: 404 });

  const row = cand as unknown as Record<string, unknown>;
  const ctxMap = await fetchCandidateSourceContextMap(supabaseServer, [candidateId]);
  const sourceContext = ctxMap.get(candidateId) ?? null;

  const projMap = await projectClaimCandidatesBatch(supabaseServer, [row], organizationId);
  const projection = projMap.get(candidateId) ?? null;

  const productIds = new Set<string>();
  const pid = claimInboxStr(row.product_id);
  const rpid = claimInboxStr(row.resolved_product_id);
  const proposed = projection?.proposed_resolved_product_id ?? null;
  if (pid) productIds.add(pid);
  if (rpid) productIds.add(rpid);
  if (proposed) productIds.add(proposed);

  const productBadges: Record<string, unknown>[] = [];
  const productBadgeSelect = await getClaimInboxProductBadgeSelect(supabaseServer);
  if (productIds.size > 0) {
    const { data: prows, error: pErr } = await supabaseServer
      .from("products")
      .select(productBadgeSelect)
      .eq("organization_id", organizationId)
      .in("id", [...productIds]);
    if (!pErr && prows) {
      for (const p of (prows as unknown) as Record<string, unknown>[]) {
        productBadges.push({
          id: claimInboxStr(p.id),
          title: claimInboxStr(p.title),
          status: claimInboxStr(p.status),
          asin: claimInboxStr(p.asin),
          fnsku: claimInboxStr(p.fnsku),
          seller_sku: claimInboxStr(p.seller_sku),
          main_image_url: claimInboxStr(p.main_image_url),
          deleted_at: p.deleted_at ?? null,
        });
      }
    }
  }

  const related_submissions = await loadRelatedSubmissionSummary(organizationId, row, sourceContext);

  return NextResponse.json({
    candidate: row,
    source_context: sourceContext,
    projection: projection
      ? {
          final_bucket: projection.final_bucket,
          inbox_queue: projection.inbox_queue,
          badges: projection.badges,
          lineage_warning_code: projection.lineage_warning_code,
          automation_allowed: projection.automation_allowed,
          proposal_from: projection.proposal_from,
          confidence: projection.confidence,
          reason_codes: projection.reason_codes,
          source_found: projection.source_found,
          proposed_resolved_product_id: projection.proposed_resolved_product_id,
        }
      : null,
    lineage_warning: projection?.lineage_warning_code
      ? {
          code: projection.lineage_warning_code,
          message:
            projection.lineage_warning_code === "stale_or_wrong_source_row_id"
              ? STALE_REMOVALS_LINEAGE_MESSAGE
              : projection.lineage_warning_code,
          automation_allowed: projection.automation_allowed,
          source_lineage_status:
            projection.lineage_warning_code === "stale_or_wrong_source_row_id"
              ? "legacy_source_broken"
              : "source_lineage_warning",
        }
      : null,
    product_badges: productBadges,
    related_submissions,
  });
}

async function loadRelatedSubmissionSummary(
  organizationId: string,
  candidate: Record<string, unknown>,
  sourceContext: Record<string, unknown> | null,
): Promise<{ return_id: string | null; rows: { id: string; status: string | null; report_url: string | null; created_at: unknown }[] }> {
  const st = claimInboxStr(candidate.source_table)?.toLowerCase() ?? "";
  const sid = claimInboxStr(candidate.source_row_id);
  let returnId: string | null = null;
  if ((st === "returns" || st === "return_items") && sid) returnId = sid;
  else if (st === "amazon_returns" && sid) {
    const { data: ar } = await supabaseServer
      .from("amazon_returns")
      .select("return_id, returns_id")
      .eq("organization_id", organizationId)
      .eq("id", sid)
      .maybeSingle();
    const arRow = ar as { return_id?: string | null; returns_id?: string | null } | null;
    returnId = claimInboxStr(arRow?.return_id) ?? claimInboxStr(arRow?.returns_id);
  }

  if (!returnId && sourceContext) {
    returnId = claimInboxStr(sourceContext.return_id) ?? claimInboxStr(sourceContext.linked_return_id);
  }

  if (!returnId || !isUuidString(returnId)) {
    return { return_id: null, rows: [] };
  }

  const { data: subs, error } = await supabaseServer
    .from("claim_submissions")
    .select("id, status, report_url, created_at")
    .eq("organization_id", organizationId)
    .eq("return_id", returnId)
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) return { return_id: returnId, rows: [] };

  const rows = (subs ?? []) as Record<string, unknown>[];
  return {
    return_id: returnId,
    rows: rows.map((r) => ({
      id: String(r.id ?? ""),
      status: claimInboxStr(r.status),
      report_url: claimInboxStr(r.report_url),
      created_at: r.created_at ?? null,
    })),
  };
}
