/**
 * REMOVAL POST-SYNC RESOLVER RECONCILE — dry-run + execute (staging)
 *
 *   npx tsx scripts/removal-post-sync-resolver-reconcile.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const DOMAIN_SYNC_MANIFEST =
  ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute/20260527T212511Z/manifest.json";
const APPROVAL_PATH =
  ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-post-sync-resolver-reconcile";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;

type BackfillProposal = {
  id: string;
  organization_id: string;
  store_id: string | null;
  order_id: string | null;
  build_source: string | null;
  bucket: string;
  promotion_preview_only: boolean;
  hints: {
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    upc: string | null;
    hydrated_asin_from_removal: boolean;
    hydrated_upc_from_removal: boolean;
  };
  before: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  after: ScannerResolutionColumns;
  apply_kind: "set_resolved" | "status_only" | "skip_unchanged";
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const backfillVal = /APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL\s*=\s*true/i.test(text);
  return {
    valid: runVal && backfillVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL: backfillVal ? "true" : "false",
    },
  };
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function probeCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const r = await client.query(
    `SELECT
      COUNT(*)::bigint AS derived_total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'resolved')::bigint AS status_resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::bigint AS ambiguous,
      COUNT(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND (identifier_resolution_status IS NULL OR identifier_resolution_status = 'unresolved')
      )::bigint AS unresolved_or_null
     FROM public.expected_packages
     WHERE build_source = ANY($1::text[])`,
    [DERIVED_SOURCES],
  );
  return r.rows[0] as Record<string, unknown>;
}

async function fetchCandidateRows(
  client: pg.Client,
  cursor: string,
  limit: number,
): Promise<RemovalExpectedPackageRow[]> {
  const res = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku,
            resolved_product_id::text, resolved_catalog_product_id::text,
            identifier_resolution_status, identifier_resolution_confidence::text,
            source_detail_row_id::text, order_id, build_source
     FROM public.expected_packages
     WHERE build_source = ANY($3::text[])
       AND organization_id IS NOT NULL AND store_id IS NOT NULL AND id > $1::uuid
     ORDER BY id LIMIT $2`,
    [cursor, limit, DERIVED_SOURCES],
  );
  return res.rows as RemovalExpectedPackageRow[];
}

async function fetchRemovalHydration(
  client: pg.Client,
  detailIds: string[],
): Promise<Map<string, { asin: string | null; upc: string | null }>> {
  const out = new Map<string, { asin: string | null; upc: string | null }>();
  for (let i = 0; i < detailIds.length; i += 500) {
    const slice = detailIds.slice(i, i + 500);
    const r = await client.query(
      `SELECT id::text, raw_data FROM public.amazon_removals WHERE id = ANY($1::uuid[])`,
      [slice],
    );
    for (const row of r.rows) {
      const hints = parseRemovalRawDataHints(row.raw_data);
      out.set(String(row.id), hints);
    }
  }
  return out;
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function buildProposals(
  supabase: ReturnType<typeof createClient>,
  pgClient: pg.Client,
  rows: RemovalExpectedPackageRow[],
  hydration: Map<string, { asin: string | null; upc: string | null }>,
): Promise<BackfillProposal[]> {
  const out: BackfillProposal[] = [];
  for (const row of rows) {
    const before = {
      resolved_product_id: n(row.resolved_product_id),
      resolved_catalog_product_id: n(row.resolved_catalog_product_id),
      identifier_resolution_status: n(row.identifier_resolution_status),
      identifier_resolution_confidence: num(row.identifier_resolution_confidence),
    };
    const detailId = n(row.source_detail_row_id);
    const removalHints = detailId ? hydration.get(detailId) : undefined;
    const resolved = await resolveExpectedPackageProduct(supabase, row, {
      asinFromRemoval: removalHints?.asin ?? null,
      upcFromRemoval: removalHints?.upc ?? null,
    });

    let after: ScannerResolutionColumns = { ...resolved.columns };
    let apply_kind: BackfillProposal["apply_kind"] = "status_only";

    if (after.identifier_resolution_status === "resolved" && after.resolved_product_id) {
      if (await productExists(pgClient, after.resolved_product_id)) {
        apply_kind = "set_resolved";
      } else {
        after = {
          ...after,
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          identifier_resolution_status: "unresolved",
        };
      }
    } else if (after.identifier_resolution_status !== "resolved") {
      after = {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        identifier_resolution_status: after.identifier_resolution_status,
        identifier_resolution_confidence: after.identifier_resolution_confidence,
      };
    }

    const unchanged =
      before.resolved_product_id === after.resolved_product_id &&
      before.resolved_catalog_product_id === after.resolved_catalog_product_id &&
      before.identifier_resolution_status === after.identifier_resolution_status &&
      before.identifier_resolution_confidence === after.identifier_resolution_confidence;

    if (unchanged) apply_kind = "skip_unchanged";

    out.push({
      id: row.id,
      organization_id: row.organization_id,
      store_id: n(row.store_id),
      order_id: n(row.order_id),
      build_source: n(row.build_source),
      bucket: resolved.bucket,
      promotion_preview_only: resolved.promotion_preview_only,
      hints: resolved.hints,
      before,
      after,
      apply_kind,
    });
  }
  return out;
}

async function applyProposals(client: pg.Client, proposals: BackfillProposal[]): Promise<number> {
  let applied = 0;
  for (const p of proposals.filter((x) => x.apply_kind !== "skip_unchanged")) {
    if (p.apply_kind === "set_resolved") {
      const r = await client.query(
        `UPDATE public.expected_packages t
         SET resolved_product_id = $2::uuid,
             resolved_catalog_product_id = $3::uuid,
             identifier_resolution_status = $4,
             identifier_resolution_confidence = $5,
             updated_at = now()
         FROM public.products pr
         WHERE t.id = $1::uuid AND pr.id = $2::uuid
         RETURNING t.id::text`,
        [
          p.id,
          p.after.resolved_product_id,
          p.after.resolved_catalog_product_id,
          p.after.identifier_resolution_status,
          p.after.identifier_resolution_confidence,
        ],
      );
      if (r.rowCount) applied += 1;
    } else {
      const r = await client.query(
        `UPDATE public.expected_packages
         SET resolved_product_id = NULL, resolved_catalog_product_id = NULL,
             identifier_resolution_status = $2, identifier_resolution_confidence = $3, updated_at = now()
         WHERE id = $1::uuid RETURNING id::text`,
        [p.id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
      );
      if (r.rowCount) applied += 1;
    }
  }
  return applied;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("Must not use original project");
  const publicUrl =
    process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  if (refFromSupabaseUrl(publicUrl) !== STAGING_REF) {
    blockers.push(`Supabase URL must be staging ${STAGING_REF}`);
  }

  let domainSyncOk = false;
  if (fs.existsSync(path.join(process.cwd(), DOMAIN_SYNC_MANIFEST))) {
    const dm = JSON.parse(fs.readFileSync(path.join(process.cwd(), DOMAIN_SYNC_MANIFEST), "utf8")) as {
      status?: string;
      rebuild_valid?: boolean;
      allocation_mismatch_count?: number;
    };
    domainSyncOk =
      dm.status === "PASS" &&
      dm.rebuild_valid === true &&
      Number(dm.allocation_mismatch_count ?? 1) === 0;
  }
  if (!domainSyncOk) {
    blockers.push("Domain sync precondition FAIL — require SP-API domain sync PASS + rebuild_valid=yes + mismatch=0");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL | ${approval.raw.APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL} |`,
      `| valid | **${approval.valid}** |`,
      `| staging_ref | \`${STAGING_REF}\` |`,
      `| domain_sync_precondition | **${domainSyncOk}** |`,
    ].join("\n") + "\n",
  );

  if (blockers.length && apply) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked: ${blockers.join("; ")}`);
  }

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run gate only; pass `--apply` to persist resolver updates.\n",
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query(`SET statement_timeout = '600s'`);

  const productsBefore = await pgClient.query(`SELECT COUNT(*)::int AS c FROM public.products`);
  const pimBefore = await pgClient.query(
    `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
  );

  const preCounts = await probeCounts(pgClient);
  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const allProposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const batch = await fetchCandidateRows(pgClient, cursor, 500);
    if (batch.length === 0) break;
    const detailIds = [
      ...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x)),
    ];
    const hydration = await fetchRemovalHydration(pgClient, detailIds);
    allProposals.push(...(await buildProposals(supabase, pgClient, batch, hydration)));
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < 500) break;
  }

  const summary = {
    derived_total: Number(preCounts.derived_total ?? 0),
    candidates_scanned: allProposals.length,
    resolved_bucket: allProposals.filter((p) => p.bucket === "resolved").length,
    ambiguous_bucket: allProposals.filter((p) => p.bucket === "ambiguous").length,
    missing_evidence_bucket: allProposals.filter((p) => p.bucket === "missing_product_needs_evidence").length,
    promotion_preview: allProposals.filter((p) => p.promotion_preview_only).length,
    set_resolved: allProposals.filter((p) => p.apply_kind === "set_resolved").length,
    status_only: allProposals.filter((p) => p.apply_kind === "status_only").length,
    skip_unchanged: allProposals.filter((p) => p.apply_kind === "skip_unchanged").length,
  };

  fs.writeFileSync(
    path.join(outDir, "resolver-dryrun-latest.md"),
    [
      "# Resolver dry-run (latest derived expected_packages)",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| derived total | **${summary.derived_total}** |`,
      `| candidates scanned | ${summary.candidates_scanned} |`,
      `| resolved (bucket) | **${summary.resolved_bucket}** |`,
      `| ambiguous | ${summary.ambiguous_bucket} |`,
      `| missing_product_needs_evidence | **${summary.missing_evidence_bucket}** |`,
      `| promotion preview (plan only) | ${summary.promotion_preview} |`,
      `| apply set_resolved | **${summary.set_resolved}** |`,
      `| apply status_only | ${summary.status_only} |`,
      `| skip unchanged | ${summary.skip_unchanged} |`,
      "",
      "Tiers: FNSKU → ASIN → SKU → UPC via `product_identifier_map` + removal raw_data hints.",
    ].join("\n") + "\n",
  );

  const preimage = allProposals
    .filter((p) => p.apply_kind !== "skip_unchanged")
    .map((p) => ({
      id: p.id,
      old_resolved_product_id: p.before.resolved_product_id,
      old_resolved_catalog_product_id: p.before.resolved_catalog_product_id,
      old_identifier_resolution_status: p.before.identifier_resolution_status,
      old_identifier_resolution_confidence: p.before.identifier_resolution_confidence,
    }));

  const rollbackSql = [
    "-- REMOVAL POST-SYNC RESOLVER RECONCILE rollback",
    `-- run_id=${runId}`,
    "BEGIN;",
    ...preimage.map((r) => {
      const rp = r.old_resolved_product_id ? `'${r.old_resolved_product_id}'::uuid` : "NULL";
      const rc = r.old_resolved_catalog_product_id ? `'${r.old_resolved_catalog_product_id}'::uuid` : "NULL";
      const st = r.old_identifier_resolution_status ? `'${r.old_identifier_resolution_status}'` : "NULL";
      const conf =
        r.old_identifier_resolution_confidence === null
          ? "NULL"
          : String(r.old_identifier_resolution_confidence);
      return `UPDATE public.expected_packages SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`;
    }),
    "COMMIT;",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql + "\n");

  const applied = await applyProposals(pgClient, allProposals);
  const postCounts = await probeCounts(pgClient);
  const productsAfter = await pgClient.query(`SELECT COUNT(*)::int AS c FROM public.products`);
  const pimAfter = await pgClient.query(
    `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
  );
  await pgClient.end();

  const appliedRows = allProposals
    .filter((p) => p.apply_kind === "set_resolved")
    .map((p) => ({
      expected_package_id: p.id,
      resolved_product_id: p.after.resolved_product_id,
      identifier_resolution_status: p.after.identifier_resolution_status,
      sku: p.hints.sku,
      fnsku: p.hints.fnsku,
    }));

  const unresolvedEvidence = allProposals
    .filter((p) => p.bucket === "missing_product_needs_evidence")
    .map((p) => ({
      expected_package_id: p.id,
      order_id: p.order_id,
      sku: p.hints.sku,
      fnsku: p.hints.fnsku,
      asin: p.hints.asin,
      upc: p.hints.upc,
      recommended_action: "requires_amazon_evidence",
    }));

  const promotionNeeded = [
    ...new Map(
      allProposals
        .filter((p) => p.promotion_preview_only && (p.hints.sku || p.hints.fnsku))
        .map((p) => [`${p.hints.sku}|${p.hints.fnsku}`, { sku: p.hints.sku, fnsku: p.hints.fnsku }]),
    ).values(),
  ];

  fs.writeFileSync(path.join(outDir, "applied-rows.json"), JSON.stringify({ count: appliedRows.length, rows: appliedRows.slice(0, 500), truncated: appliedRows.length > 500 }, null, 2));
  fs.writeFileSync(path.join(outDir, "unresolved-evidence-needed.json"), JSON.stringify({ count: unresolvedEvidence.length, rows: unresolvedEvidence.slice(0, 500), truncated: unresolvedEvidence.length > 500 }, null, 2));
  fs.writeFileSync(path.join(outDir, "product-promotion-needed.json"), JSON.stringify({ count: promotionNeeded.length, candidates: promotionNeeded }, null, 2));

  const execBlockers: string[] = [];
  if (Number(productsAfter.rows[0]?.c) !== Number(productsBefore.rows[0]?.c)) {
    execBlockers.push("products count changed (forbidden)");
  }
  if (Number(pimAfter.rows[0]?.c) !== Number(pimBefore.rows[0]?.c)) {
    execBlockers.push("product_identifier_map count changed (forbidden)");
  }

  const nextPrompt =
    execBlockers.length === 0
      ? "PC03D-EVIDENCE-QUEUE-FROM-REMOVAL-RESOLVER — refresh Amazon evidence queue for missing_product_needs_evidence rows"
      : "REMOVAL-POST-SYNC-RESOLVER-RECONCILE — investigate guardrail violation and re-run";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [...blockers, ...execBlockers].length
      ? [...blockers, ...execBlockers].map((b) => `- ${b}`).join("\n") + "\n"
      : "- None\n",
  );

  const manifest = {
    prompt: "REMOVAL-POST-SYNC-RESOLVER-RECONCILE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: execBlockers.length ? "FAIL" : "PASS",
    derived_total: summary.derived_total,
    resolved_count: Number(postCounts.resolved ?? 0),
    unresolved_evidence_count: summary.missing_evidence_bucket,
    applied_update_count: applied,
    set_resolved_proposals: summary.set_resolved,
    pre_counts: preCounts,
    post_counts: postCounts,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
  if (execBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
