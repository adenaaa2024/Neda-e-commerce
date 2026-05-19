import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../../../dashboard/products/pim-actions";
import {
  applyBulkEdgeOperatorReview,
  parseEdgeReviewStatus,
  type BulkEdgeReviewScope,
} from "../../../../../../../../lib/claim-evidence-edge-review";
import { fetchDraftRow, loadPersistedEvidenceSummary } from "../../../../../../../../lib/claim-evidence-preview";
import { supabaseServer } from "../../../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../../../lib/uuid";

export const dynamic = "force-dynamic";

type BulkBody = {
  organization_id?: string;
  status?: string;
  scope?: string;
  group_key?: string | null;
  note?: string | null;
};

function parseScope(v: unknown): BulkEdgeReviewScope | null {
  const s = String(v ?? "").trim();
  return s === "all" || s === "group" ? s : null;
}

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await ctx.params;
  if (!isUuidString(draftId)) {
    return NextResponse.json({ error: "Invalid draft id." }, { status: 400 });
  }

  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const status = parseEdgeReviewStatus(body.status);
  const scope = parseScope(body.scope);
  if (!status || !scope) {
    return NextResponse.json(
      { error: "status and scope (all|group) are required." },
      { status: 400 },
    );
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const draft = await fetchDraftRow(supabaseServer, organizationId, draftId);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const summary = await loadPersistedEvidenceSummary(supabaseServer, organizationId, draftId);

  try {
    const result = await applyBulkEdgeOperatorReview(supabaseServer, {
      organizationId,
      draftId,
      status,
      scope,
      groupKey: body.group_key,
      generationId: summary.latest_generation_id,
      note: body.note,
      reviewedBy: gate.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("missing") || msg.includes("does not exist")) {
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    if (msg.includes("No persisted edges")) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
