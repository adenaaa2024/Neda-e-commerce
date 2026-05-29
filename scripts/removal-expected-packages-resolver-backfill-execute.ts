/**
 * REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL — dry-run default + optional execute.
 *
 * Scoped to derived expected_packages (detail_shipment, detail_remainder).
 * No products.insert. No product_identifier_map.insert. No title-only promotion.
 *
 *   npx tsx scripts/removal-expected-packages-resolver-backfill-execute.ts --run-id=<id>
 *   npx tsx scripts/removal-expected-packages-resolver-backfill-execute.ts --run-id=<id> --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_DRY_RUN = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-dry-run";
const OUT_EXECUTE = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-execute";
const OUT_AFTER_REBUILD = ".cursor/audit-reports/removal-resolver-execute-after-rebuild";
const REBUILD_VERIFY_BASE = ".cursor/audit-reports/removal-rebuild-verify-and-resolver-dryrun";
const APPROVAL_PATH =
  ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md";
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
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function outBaseArg(execute: boolean): string {
  const a = process.argv.find((x) => x.startsWith("--out-base="));
  if (a) return a.split("=")[1]!.trim();
  if (hasFlag("--after-rebuild")) return OUT_AFTER_REBUILD;
  return execute ? OUT_EXECUTE : OUT_DRY_RUN;
}

function rebuildVerifyRef(): string | null {
  const a = process.argv.find((x) => x.startsWith("--rebuild-verify-run-id="));
  if (!a) return null;
  const id = a.split("=")[1]!.trim();
  return `${REBUILD_VERIFY_BASE}/${id}`;
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

function readApprovalFlag(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL\s*=\s*true/i.test(text)
  );
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
    `SELECT
      id::text,
      organization_id::text,
      store_id::text,
      sku,
      fnsku,
      resolved_product_id::text,
      resolved_catalog_product_id::text,
      identifier_resolution_status,
      identifier_resolution_confidence::text,
      source_detail_row_id::text,
      order_id,
      build_source
     FROM public.expected_packages
     WHERE build_source = ANY($3::text[])
       AND organization_id IS NOT NULL
       AND store_id IS NOT NULL
       AND id > $1::uuid
     ORDER BY id
     LIMIT $2`,
    [cursor, limit, DERIVED_SOURCES],
  );
  return res.rows as RemovalExpectedPackageRow[];
}

type RemovalHydration = {
  asin: string | null;
  upc: string | null;
};

async function fetchRemovalHydration(
  client: pg.Client,
  detailIds: string[],
): Promise<Map<string, RemovalHydration>> {
  const out = new Map<string, RemovalHydration>();
  if (detailIds.length === 0) return out;

  const CHUNK = 500;
  for (let i = 0; i < detailIds.length; i += CHUNK) {
    const slice = detailIds.slice(i, i + CHUNK);
    const r = await client.query(
      `SELECT id::text, raw_data
       FROM public.amazon_removals
       WHERE id = ANY($1::uuid[])`,
      [slice],
    );
    for (const row of r.rows) {
      const id = String(row.id);
      const rawHints = parseRemovalRawDataHints(row.raw_data);
      out.set(id, {
        asin: rawHints.asin,
        upc: rawHints.upc,
      });
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
  hydration: Map<string, RemovalHydration>,
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
      const ok = await productExists(pgClient, after.resolved_product_id);
      if (ok) {
        apply_kind = "set_resolved";
      } else {
        after = {
          ...after,
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          identifier_resolution_status: "unresolved",
        };
        apply_kind = "status_only";
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
  const toApply = proposals.filter((p) => p.apply_kind !== "skip_unchanged");
  for (const p of toApply) {
    if (p.apply_kind === "set_resolved") {
      const r = await client.query(
        `UPDATE public.expected_packages t
         SET resolved_product_id = $2::uuid,
             resolved_catalog_product_id = $3::uuid,
             identifier_resolution_status = $4,
             identifier_resolution_confidence = $5,
             updated_at = now()
         FROM public.products pr
         WHERE t.id = $1::uuid
           AND pr.id = $2::uuid
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
         SET resolved_product_id = NULL,
             resolved_catalog_product_id = NULL,
             identifier_resolution_status = $2,
             identifier_resolution_confidence = $3,
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text`,
        [p.id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
      );
      if (r.rowCount) applied += 1;
    }
  }
  return applied;
}

function queueRow(p: BackfillProposal): Record<string, unknown> {
  return {
    expected_package_id: p.id,
    organization_id: p.organization_id,
    store_id: p.store_id,
    order_id: p.order_id,
    build_source: p.build_source,
    sku: p.hints.sku,
    fnsku: p.hints.fnsku,
    asin: p.hints.asin,
    upc: p.hints.upc,
    bucket: p.bucket,
    apply_kind: p.apply_kind,
    proposed_resolved_product_id: p.after.resolved_product_id,
    identifier_resolution_status: p.after.identifier_resolution_status,
  };
}

function writeJsonl(filePath: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const afterRebuild = hasFlag("--after-rebuild") || outBaseArg(execute) === OUT_AFTER_REBUILD;
  const outBase = outBaseArg(execute);
  const rebuildVerify = rebuildVerifyRef();
  const outDir = path.join(process.cwd(), outBase, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  if (execute && !readApprovalFlag()) {
    throw new Error(
      `Execute blocked: set APPROVED_TO_RUN_STAGING=true and APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL=true in ${APPROVAL_PATH}`,
    );
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query(`SET statement_timeout = '300s'`);
  const preCounts = await probeCounts(pgClient);

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const allProposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  const PAGE = 500;
  for (;;) {
    const batch = await fetchCandidateRows(pgClient, cursor, PAGE);
    if (batch.length === 0) break;

    const detailIds = [
      ...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x)),
    ];
    const hydration = await fetchRemovalHydration(pgClient, detailIds);
    allProposals.push(...(await buildProposals(supabase, pgClient, batch, hydration)));
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < PAGE) break;
  }

  const resolvedQueue = allProposals.filter((p) => p.bucket === "resolved");
  const ambiguousQueue = allProposals.filter((p) => p.bucket === "ambiguous");
  const missingEvidenceQueue = allProposals.filter((p) => p.bucket === "missing_product_needs_evidence");
  const promotionPreviewQueue = missingEvidenceQueue.filter((p) => p.promotion_preview_only);

  const summary = {
    candidates_scanned: allProposals.length,
    set_resolved: allProposals.filter((p) => p.apply_kind === "set_resolved").length,
    status_only: allProposals.filter((p) => p.apply_kind === "status_only").length,
    skip_unchanged: allProposals.filter((p) => p.apply_kind === "skip_unchanged").length,
    queue_resolved: resolvedQueue.length,
    queue_ambiguous: ambiguousQueue.length,
    queue_missing_product_needs_evidence: missingEvidenceQueue.length,
    queue_product_promotion_candidate_preview: promotionPreviewQueue.length,
    by_bucket: allProposals.reduce(
      (acc, p) => {
        acc[p.bucket] = (acc[p.bucket] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
  };

  writeJsonl(path.join(outDir, "queue-resolved.jsonl"), resolvedQueue.map(queueRow));
  writeJsonl(path.join(outDir, "queue-ambiguous.jsonl"), ambiguousQueue.map(queueRow));
  writeJsonl(
    path.join(outDir, "queue-missing-product-needs-evidence.jsonl"),
    missingEvidenceQueue.map((p) => ({
      ...queueRow(p),
      recommended_action: "requires_amazon_evidence",
    })),
  );
  writeJsonl(
    path.join(outDir, "queue-product-promotion-candidate.jsonl"),
    promotionPreviewQueue.map((p) => ({
      ...queueRow(p),
      preview_only: true,
      requires_amazon_evidence_first: true,
      recommended_next: "PC03D then E2 promotion execute",
    })),
  );

  fs.writeFileSync(path.join(outDir, "resolver-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "pre-counts.json"), JSON.stringify(preCounts, null, 2));

  const preimageRows = allProposals
    .filter((p) => p.apply_kind !== "skip_unchanged")
    .map((p) => ({
      id: p.id,
      old_resolved_product_id: p.before.resolved_product_id,
      old_resolved_catalog_product_id: p.before.resolved_catalog_product_id,
      old_identifier_resolution_status: p.before.identifier_resolution_status,
      old_identifier_resolution_confidence: p.before.identifier_resolution_confidence,
    }));
  fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(preimageRows, null, 2));
  const rollbackSql = preimageRows.map((r) => {
    const rp = r.old_resolved_product_id === null ? "NULL" : `'${r.old_resolved_product_id}'::uuid`;
    const rc =
      r.old_resolved_catalog_product_id === null
        ? "NULL"
        : `'${r.old_resolved_catalog_product_id}'::uuid`;
    const st =
      r.old_identifier_resolution_status === null
        ? "NULL"
        : `'${r.old_identifier_resolution_status}'`;
    const conf =
      r.old_identifier_resolution_confidence === null
        ? "NULL"
        : String(r.old_identifier_resolution_confidence);
    return `UPDATE public.expected_packages SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`;
  });
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    ["-- REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL rollback", ...rollbackSql].join("\n"),
    "utf8",
  );

  let applied = 0;
  if (execute) {
    applied = await applyProposals(pgClient, allProposals);
  }

  const postCounts = execute ? await probeCounts(pgClient) : null;
  await pgClient.end();

  const nextPrompt = execute
    ? afterRebuild
      ? "PC03D-EVIDENCE-QUEUE-FROM-REMOVAL-RESOLVER — refresh Amazon evidence queue for post-rebuild missing_product_needs_evidence rows"
      : "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-VERIFY — post-execute counts + PC03D evidence queue for missing_product_needs_evidence rows"
    : afterRebuild
      ? "REMOVAL-RESOLVER-EXECUTE-AFTER-REBUILD — set approval true and rerun with --execute --after-rebuild"
      : "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE — set approval true and rerun with --execute after dry-run review";

  const manifest = {
    prompt: execute
      ? afterRebuild
        ? "REMOVAL-RESOLVER-EXECUTE-AFTER-REBUILD"
        : "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE"
      : afterRebuild
        ? "REMOVAL-RESOLVER-DRY-RUN-AFTER-REBUILD"
        : "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-DRY-RUN",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "execute" : "dry_run",
    after_rebuild: afterRebuild,
    rebuild_verify_ref: rebuildVerify,
    product_creation_blocked: true,
    no_db_writes_in_dry_run: !execute,
    ...summary,
    eligible_apply: summary.set_resolved + summary.status_only,
    applied,
    pre_counts: preCounts,
    post_counts: postCounts,
    exact_next_prompt: nextPrompt,
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (postCounts) fs.writeFileSync(path.join(outDir, "post-counts.json"), JSON.stringify(postCounts, null, 2));

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execute && !readApprovalFlag()
      ? "# Blockers\n\nExecute requires approval flag true.\n"
      : "# Blockers\n\nNone.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# ${manifest.prompt}`,
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- mode: ${execute ? "execute" : "dry-run"}`,
      `- candidates scanned: ${summary.candidates_scanned}`,
      `- **resolved queue:** ${summary.queue_resolved}`,
      `- **ambiguous queue:** ${summary.queue_ambiguous}`,
      `- **missing_product_needs_evidence:** ${summary.queue_missing_product_needs_evidence}`,
      `- **product_promotion_candidate preview:** ${summary.queue_product_promotion_candidate_preview}`,
      `- set_resolved (FK-safe apply proposals): ${summary.set_resolved}`,
      `- skip_unchanged: ${summary.skip_unchanged}`,
      `- applied: ${applied}`,
      "",
      `**Next prompt:** ${nextPrompt}`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
