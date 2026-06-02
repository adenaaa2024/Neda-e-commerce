import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import {
  CLAIM_INTAKE_GENERATOR_SOURCE_TABLES,
  CLAIM_INTAKE_IDEMPOTENCY_STRATEGY,
  runClaimIntakeGeneratorForTable,
  type ClaimIntakeGeneratorSourceTable,
} from "@/lib/claim-intake-candidate-generators";
import { assertStoreBelongsToOrganization } from "@/lib/claim-org-scope";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

type Body = {
  organization_id?: string;
  store_id?: string;
  source_tables?: string[];
  limit_per_table?: number;
  offset?: number;
  dry_run?: boolean;
};

/** Explicit manual generator run — dry_run defaults true. No marketplace submit. */
export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  const dryRun = body.dry_run !== false;
  const limit = Math.min(500, Math.max(1, Number(body.limit_per_table ?? 100) || 100));
  const offset = Math.max(0, Math.floor(Number(body.offset ?? 0) || 0));

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "store_id must be a UUID." }, { status: 400 });
  }

  if (!dryRun && process.env.CLAIM_INTAKE_GENERATOR_CONFIRM_APPLY?.trim() !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "Set CLAIM_INTAKE_GENERATOR_CONFIRM_APPLY=true for apply (writes claim_candidate_drafts only).",
      },
      { status: 403 },
    );
  }

  const access = await assertUserCanAccessOrganization(organizationId);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error },
      { status: access.error === "Not signed in." ? 401 : 403 },
    );
  }

  const storeOk = await assertStoreBelongsToOrganization(organizationId, storeId);
  if (!storeOk.ok) {
    return NextResponse.json({ ok: false, error: storeOk.error }, { status: storeOk.status });
  }

  const requested = Array.isArray(body.source_tables) ? body.source_tables : [...CLAIM_INTAKE_GENERATOR_SOURCE_TABLES];
  const tables = requested.filter((t): t is ClaimIntakeGeneratorSourceTable =>
    (CLAIM_INTAKE_GENERATOR_SOURCE_TABLES as readonly string[]).includes(t),
  );
  if (!tables.length) {
    return NextResponse.json({ ok: false, error: "No valid source_tables." }, { status: 400 });
  }

  const generatedBy = dryRun ? "api_dry_run" : "api_explicit_apply";
  const batches = [];
  for (const sourceTable of tables) {
    const batch = await runClaimIntakeGeneratorForTable({
      client: supabaseServer,
      organizationId,
      storeId,
      sourceTable,
      limit,
      offset,
      dryRun,
      generatedBy,
    });
    batches.push(batch);
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    batches,
    idempotency_strategy: CLAIM_INTAKE_IDEMPOTENCY_STRATEGY,
    claim_intake_generators_status: Object.fromEntries(
      tables.map((t) => [t, dryRun ? "dry_run_ok" : "applied_to_drafts"]),
    ),
    marketplace_submit: false,
    return_items_writes: false,
  });
}
