import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { loadAndBuildReferenceCandidatesForDraft } from "../../../../../../lib/claim-reference-candidates";
import { resolveDraftForCandidate } from "../../../../../../lib/claim-evidence-preview";
import { claimInboxStr } from "../../../../../../lib/claim-inbox-projection";
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
        error: "Cannot resolve operational source for reference candidates.",
        claim_candidate_id: candidateId,
      },
      { status: 422 },
    );
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.min(120, Math.max(1, Number(limitRaw) || 80)) : undefined;

  const body = await loadAndBuildReferenceCandidatesForDraft(supabaseServer, draft, {
    claim_candidate_id: candidateId,
    limit,
  });

  return NextResponse.json(body);
}
