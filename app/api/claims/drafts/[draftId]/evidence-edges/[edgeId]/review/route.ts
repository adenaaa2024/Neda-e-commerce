import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../../../dashboard/products/pim-actions";
import {
  applyEdgeOperatorReview,
  parseEdgeReviewStatus,
} from "../../../../../../../../lib/claim-evidence-edge-review";
import { fetchDraftRow } from "../../../../../../../../lib/claim-evidence-preview";
import { supabaseServer } from "../../../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../../../lib/uuid";

export const dynamic = "force-dynamic";

type ReviewBody = {
  organization_id?: string;
  status?: string;
  note?: string | null;
};

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string; edgeId: string }> }) {
  const { draftId, edgeId } = await ctx.params;
  if (!isUuidString(draftId) || !isUuidString(edgeId)) {
    return NextResponse.json({ error: "Invalid draft or edge id." }, { status: 400 });
  }

  let body: ReviewBody;
  try {
    body = (await req.json()) as ReviewBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const status = parseEdgeReviewStatus(body.status);
  if (!status) {
    return NextResponse.json(
      { error: "status must be accepted, rejected, or needs_review." },
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

  try {
    const result = await applyEdgeOperatorReview(supabaseServer, {
      organizationId,
      draftId,
      edgeId,
      status,
      note: body.note,
      reviewedBy: gate.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("missing") || msg.includes("does not exist")) {
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    if (msg.includes("not found")) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
