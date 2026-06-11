import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import {
  auditAmazonProductSyncHealth,
  runAmazonProductSyncCatchUp,
} from "@/lib/amazon-product-sync-recovery";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

/**
 * GET /api/dashboard/products/amazon-sync-recovery?organization_id=&store_id=
 * POST body: { organization_id, store_id, apply?: boolean, promote_limit?, enrich_batches? }
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();

  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id and store_id must be valid UUIDs." },
      { status: 400 },
    );
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!dbUrl) {
    return NextResponse.json(
      { ok: false, error: "STAGING_DIRECT_POSTGRES_URL not configured on server." },
      { status: 503 },
    );
  }

  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const report = await auditAmazonProductSyncHealth({
      pgClient: client,
      organizationId,
      storeId,
      runId,
    });

    return NextResponse.json({
      ok: true,
      last_successful_sync: report.last_successful_sync,
      products_missing: report.products_missing,
      products_stale: report.products_stale,
      image_sync_failures: report.image_sync_failures,
      scheduler_status: report.scheduler_status,
      auto_create_status: report.auto_create_status,
      SAFE_FOR_ORIGINAL: report.SAFE_FOR_ORIGINAL,
      report,
    });
  } finally {
    await client.end();
  }
}

export async function POST(req: Request) {
  let body: {
    organization_id?: string;
    store_id?: string;
    apply?: boolean;
    promote_limit?: number;
    enrich_batches?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id and store_id must be valid UUIDs." },
      { status: 400 },
    );
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!dbUrl) {
    return NextResponse.json(
      { ok: false, error: "STAGING_DIRECT_POSTGRES_URL not configured on server." },
      { status: 503 },
    );
  }

  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const result = await runAmazonProductSyncCatchUp({
      pgClient: client,
      supabase: supabaseServer,
      organizationId,
      storeId,
      runId,
      apply: body.apply === true,
      promoteLimit: body.promote_limit,
      enrichBatches: body.enrich_batches,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          last_successful_sync: result.report.last_successful_sync,
          products_missing: result.report.products_missing,
          products_stale: result.report.products_stale,
          image_sync_failures: result.report.image_sync_failures,
          scheduler_status: result.report.scheduler_status,
          auto_create_status: result.report.auto_create_status,
          SAFE_FOR_ORIGINAL: result.report.SAFE_FOR_ORIGINAL,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      mode: result.mode,
      promoted: result.promoted,
      enriched: result.enriched,
      last_successful_sync: result.report.last_successful_sync,
      products_missing: result.report.products_missing,
      products_stale: result.report.products_stale,
      image_sync_failures: result.report.image_sync_failures,
      scheduler_status: result.report.scheduler_status,
      auto_create_status: result.report.auto_create_status,
      SAFE_FOR_ORIGINAL: result.report.SAFE_FOR_ORIGINAL,
    });
  } finally {
    await client.end();
  }
}
