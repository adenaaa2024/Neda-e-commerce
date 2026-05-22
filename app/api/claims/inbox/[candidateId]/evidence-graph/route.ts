import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import {
  buildClaimEvidenceGraphResponse,
  resolveDraftForCandidate,
} from "../../../../../../lib/claim-evidence-preview";
import { claimInboxStr, projectClaimCandidatesBatch } from "../../../../../../lib/claim-inbox-projection";
import { getClaimInboxListSelect } from "../../../../../../lib/claim-inbox-schema";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";

export const dynamic = "force-dynamic";

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

  const listSelect = await getClaimInboxListSelect(supabaseServer);
  const { data: cand, error: cErr } = await supabaseServer
    .from("claim_candidates")
    .select(listSelect)
    .eq("id", candidateId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
  if (!cand) return NextResponse.json({ error: "Candidate not found." }, { status: 404 });

  const candidate = cand as unknown as Record<string, unknown>;
  const projMap = await projectClaimCandidatesBatch(supabaseServer, [candidate], organizationId);
  const projection = projMap.get(candidateId) ?? null;

  const draft = await resolveDraftForCandidate(supabaseServer, organizationId, {
    id: candidateId,
    source_table: claimInboxStr(candidate.source_table),
    source_row_id: claimInboxStr(candidate.source_row_id),
    sku: claimInboxStr(candidate.sku),
    store_id: claimInboxStr(candidate.store_id),
  });

  if (!draft) {
    return NextResponse.json(
      {
        error: "Cannot resolve operational source for evidence preview.",
        claim_candidate_id: candidateId,
      },
      { status: 422 },
    );
  }

  const includeList = url.searchParams.get("include_persisted_edges") !== "false";
  const body = await buildClaimEvidenceGraphResponse(supabaseServer, draft, {
    claim_candidate_id: candidateId,
    lineage_warning_code: projection?.lineage_warning_code ?? null,
    inbox_queue: projection?.inbox_queue ?? null,
    includePersistedEdgeList: includeList,
  });

  return NextResponse.json({
    ...body,
    claim_candidate_id: candidateId,
    projection: projection
      ? {
          inbox_queue: projection.inbox_queue,
          final_bucket: projection.final_bucket,
          badges: projection.badges,
          lineage_warning_code: projection.lineage_warning_code,
        }
      : null,
  });
}
