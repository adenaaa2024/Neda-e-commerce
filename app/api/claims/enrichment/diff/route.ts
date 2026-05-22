import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { isClaimDraftsReviewEnabled } from "@/lib/claim-drafts-api";
import { getClaimEnrichmentDiff, parseSinceGenerationNumber, enrichmentDiffSchemaAvailable } from "@/lib/claim-enrichment-diff";
import { isClaimReviewWorkflowEnabled } from "@/lib/claim-review-workflow";
import { assertStoreBelongsToOrganization } from "@/lib/claim-org-scope";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

/**
 * GET /api/claims/enrichment/diff?draft_id=&since_generation=&organization_id=&store_id=
 * Read-only prototype: no writes, no migrations. Returns `configured: false` when CCE tables are absent.
 */
export async function GET(req: Request) {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(req.url);
  const draftId = String(url.searchParams.get("draft_id") ?? "").trim();
  const sinceRaw = String(url.searchParams.get("since_generation") ?? "").trim();
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeIdRaw = String(url.searchParams.get("store_id") ?? "").trim();
  const includeEdges = !["0", "false", "no"].includes(String(url.searchParams.get("include_edges") ?? "true").trim().toLowerCase());
  const includeEvents = ["1", "true", "yes"].includes(String(url.searchParams.get("include_events") ?? "").trim().toLowerCase());
  const maxEdges = Math.min(500, Math.max(1, Number.parseInt(String(url.searchParams.get("max_edges") ?? "100"), 10) || 100));
  const maxEvents = Math.min(500, Math.max(1, Number.parseInt(String(url.searchParams.get("max_events") ?? "50"), 10) || 50));

  if (!isUuidString(draftId) || !isUuidString(organizationId)) {
    return NextResponse.json({ error: "draft_id and organization_id must be UUIDs." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  if (storeIdRaw && !isUuidString(storeIdRaw)) {
    return NextResponse.json({ error: "store_id must be a UUID when provided." }, { status: 400 });
  }

  if (storeIdRaw) {
    const storeOk = await assertStoreBelongsToOrganization(organizationId, storeIdRaw);
    if (!storeOk.ok) {
      return NextResponse.json({ error: storeOk.error }, { status: storeOk.status });
    }
  }

  const schemaOk = await enrichmentDiffSchemaAvailable(supabaseServer);
  if (!schemaOk) {
    return NextResponse.json(
      {
        configured: false,
        reason: "claim enrichment tables are not installed",
        draft_id: draftId,
        since_generation: sinceRaw || "",
        organization_id: organizationId,
        changes: [],
        next_required_step: "apply additive CCE DDL in a later governed migration",
      },
      { status: 200 },
    );
  }

  const parsed = parseSinceGenerationNumber(sinceRaw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await getClaimEnrichmentDiff({
    client: supabaseServer,
    organizationId,
    draftId,
    sinceGeneration: parsed.value,
    includeEdges,
    includeEvents,
    maxEdges,
    maxEvents,
  });

  if (result.ok === "not_configured") {
    return NextResponse.json(result.body, { status: 200 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const resolvedStore = result.body.store_id;
  if (storeIdRaw && resolvedStore && storeIdRaw !== resolvedStore) {
    return NextResponse.json({ error: "store_id does not match the draft's store_id." }, { status: 400 });
  }

  return NextResponse.json(result.body, { status: 200 });
}
