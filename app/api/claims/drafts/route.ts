import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import { assertUserCanAccessOrganization } from "../../../dashboard/products/pim-actions";
import {
  CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS,
  isAllowedDraftLifecycleStatus,
  isAllowedDraftSourceTable,
  isClaimDraftsReviewEnabled,
} from "../../../../lib/claim-drafts-api";
import { projectClaimCandidateDraftsBatch, type ProjectedClaimDraft } from "../../../../lib/claim-inbox-projection";
import { assertStoreBelongsToOrganization } from "../../../../lib/claim-org-scope";
import { supabaseServer } from "../../../../lib/supabase-server";
import { isUuidString } from "../../../../lib/uuid";

const MAX_LIMIT = 100;

type KeysetCursor = { ca: string; id: string };

function encodeKeysetCursor(c: KeysetCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeKeysetCursor(raw: string | null): KeysetCursor | null {
  if (!raw?.trim()) return null;
  try {
    const o = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8")) as {
      ca?: unknown;
      id?: unknown;
    };
    const ca = typeof o.ca === "string" ? o.ca.trim() : "";
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!ca || !isUuidString(id)) return null;
    return { ca, id };
  } catch {
    return null;
  }
}

function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "50", 10) || 50;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

export async function GET(req: Request) {
  if (!isClaimDraftsReviewEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
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

  const storeIdParam = String(url.searchParams.get("store_id") ?? "").trim();
  if (storeIdParam) {
    if (!isUuidString(storeIdParam)) {
      return NextResponse.json({ error: "store_id must be a UUID when provided." }, { status: 400 });
    }
    const storeOk = await assertStoreBelongsToOrganization(organizationId, storeIdParam);
    if (!storeOk.ok) {
      return NextResponse.json({ error: storeOk.error }, { status: storeOk.status });
    }
  }

  const lifecycleRaw = String(url.searchParams.get("lifecycle_status") ?? "").trim();
  if (lifecycleRaw && !isAllowedDraftLifecycleStatus(lifecycleRaw)) {
    return NextResponse.json({ error: "Invalid lifecycle_status." }, { status: 400 });
  }

  const sourceTableRaw = String(url.searchParams.get("source_table") ?? "").trim();
  if (sourceTableRaw && !isAllowedDraftSourceTable(sourceTableRaw)) {
    return NextResponse.json({ error: "Invalid source_table." }, { status: 400 });
  }

  const limit = clampLimit(url.searchParams.get("limit"));
  const includeTotal = ["1", "true", "yes"].includes(
    String(url.searchParams.get("include_total") ?? "").trim().toLowerCase(),
  );

  const projectionRequested = ["1", "true", "yes"].includes(
    String(url.searchParams.get("projection") ?? "").trim().toLowerCase(),
  );

  const cursor = decodeKeysetCursor(url.searchParams.get("cursor")?.trim() || null);

  try {
    let q = supabaseServer
      .from("claim_candidate_drafts")
      .select(CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS)
      .eq("organization_id", organizationId);

    if (storeIdParam) q = q.eq("store_id", storeIdParam);
    if (lifecycleRaw) q = q.eq("lifecycle_status", lifecycleRaw);
    if (sourceTableRaw) q = q.eq("source_table", sourceTableRaw);

    if (cursor) {
      const ts = cursor.ca.split('"').join("");
      const idEsc = cursor.id.split('"').join("");
      q = q.or(`created_at.lt."${ts}",and(created_at.eq."${ts}",id.lt.${idEsc}))`);
    }

    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (((data ?? []) as unknown) as unknown as Record<string, unknown>[]) ?? [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.length > 0 ? page[page.length - 1] : null;
    const lastCa = last && typeof last.created_at === "string" ? last.created_at : null;
    const lastId = last && typeof last.id === "string" && isUuidString(last.id) ? last.id : null;
    const next_cursor =
      hasMore && lastCa && lastId ? encodeKeysetCursor({ ca: lastCa, id: lastId }) : null;

    let total_matching: number | null = null;
    if (includeTotal) {
      let cq = supabaseServer
        .from("claim_candidate_drafts")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId);
      if (storeIdParam) cq = cq.eq("store_id", storeIdParam);
      if (lifecycleRaw) cq = cq.eq("lifecycle_status", lifecycleRaw);
      if (sourceTableRaw) cq = cq.eq("source_table", sourceTableRaw);
      const { count, error: cErr } = await cq;
      if (!cErr) total_matching = count ?? 0;
    }

    const base = {
      items: page,
      next_cursor,
      total_matching,
    };

    if (!projectionRequested) {
      return NextResponse.json(base);
    }

    const projMap = await projectClaimCandidateDraftsBatch(supabaseServer, page, organizationId);
    const draft_projections: Record<string, ProjectedClaimDraft> = Object.fromEntries(projMap);

    return NextResponse.json({
      ...base,
      draft_projections,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Query failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
