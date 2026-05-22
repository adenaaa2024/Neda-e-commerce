import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import {
  acknowledgeEvidenceWarnings,
  filterActionableWarnings,
} from "@/lib/claim-evidence-filing-readiness";
import {
  buildClaimEvidencePreview,
  fetchDraftRow,
} from "@/lib/claim-evidence-preview";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const dynamic = "force-dynamic";

type AckBody = {
  organization_id?: string;
};

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await ctx.params;
  if (!isUuidString(draftId)) {
    return NextResponse.json({ error: "Invalid draft id." }, { status: 400 });
  }

  let body: AckBody;
  try {
    body = (await req.json()) as AckBody;
  } catch {
    body = {};
  }

  const organizationId = String(body.organization_id ?? "").trim();
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

  const draft = await fetchDraftRow(supabaseServer, organizationId, draftId);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const graph = await buildClaimEvidencePreview(supabaseServer, draft);
  const warningCodes = filterActionableWarnings(graph.warnings).map((w) => w.code);

  try {
    const operator_state = await acknowledgeEvidenceWarnings(supabaseServer, {
      organizationId,
      draftId,
      reviewedBy: gate.userId,
      warningCodes,
    });
    return NextResponse.json({ ok: true, operator_state, warning_codes: warningCodes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("missing")) {
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
