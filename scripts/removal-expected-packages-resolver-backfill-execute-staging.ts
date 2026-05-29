/**
 * REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE (staging Sam cohort)
 *
 *   npx tsx scripts/removal-expected-packages-resolver-backfill-execute-staging.ts --run-id=<UTC_Z> --execute
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
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-execute";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md";
const PREALLOC = ".cursor/audit-reports/removal-expected-allocation-fix-execute/20260528T020733Z/manifest.json";
const PRECARRIER = ".cursor/audit-reports/removal-carrier-normalization-view-safe-fix/20260528T024122Z/manifest.json";
const PRERECEIVE = ".cursor/audit-reports/expected-receive-split-execute-staging/20260528T042214Z/manifest.json";
const RESOLVER_SOURCES = ["detail_shipment", "detail_remainder", "receive_allocated"] as const;
const SAMPLE_FNSKU = "X004JWH5NB";
const SAMPLE_TRACKING = "2320305295";

type BackfillProposal = {
  id: string;
  organization_id: string;
  store_id: string | null;
  order_id: string | null;
  build_source: string | null;
  tracking_number: string | null;
  bucket: string;
  hints: { sku: string | null; fnsku: string | null; asin: string | null; upc: string | null };
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
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

function readApproval(): { approved: boolean; runStaging: boolean; backfill: boolean } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runStaging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const backfill = /APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL\s*=\s*true/i.test(text);
  return { approved: runStaging && backfill, runStaging, backfill };
}

function loadPre<T>(rel: string): T | null {
  const p = path.join(process.cwd(), rel);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T) : null;
}

async function probeCoverage(client: pg.Client) {
  const r = await client.query(
    `SELECT
      COUNT(*)::int AS total_all,
      COUNT(*) FILTER (WHERE build_source = ANY($3::text[]))::int AS cohort_total,
      COUNT(*) FILTER (WHERE build_source = ANY($3::text[]) AND resolved_product_id IS NOT NULL)::int AS cohort_resolved,
      COUNT(*) FILTER (WHERE build_source = ANY($3::text[]) AND identifier_resolution_status = 'ambiguous')::int AS cohort_ambiguous,
      COUNT(*) FILTER (
        WHERE build_source = ANY($3::text[])
          AND resolved_product_id IS NULL
          AND (identifier_resolution_status IS NULL OR identifier_resolution_status = 'unresolved')
      )::int AS cohort_unresolved,
      COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment_total,
      COUNT(*) FILTER (WHERE build_source = 'detail_shipment' AND resolved_product_id IS NOT NULL)::int AS detail_shipment_resolved,
      COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder_total,
      COUNT(*) FILTER (WHERE build_source = 'detail_remainder' AND resolved_product_id IS NOT NULL)::int AS detail_remainder_resolved,
      COUNT(*) FILTER (WHERE build_source = 'receive_allocated')::int AS receive_allocated_total,
      COUNT(*) FILTER (WHERE build_source = 'receive_allocated' AND resolved_product_id IS NOT NULL)::int AS receive_allocated_resolved
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [SAM_ORG, SAM_STORE, RESOLVER_SOURCES],
  );
  return r.rows[0] as Record<string, number>;
}

async function fetchCandidateRows(client: pg.Client, cursor: string, limit: number) {
  const res = await client.query(
    `SELECT ep.id::text, ep.organization_id::text, ep.store_id::text, ep.sku, ep.fnsku,
      ep.resolved_product_id::text, ep.resolved_catalog_product_id::text,
      ep.identifier_resolution_status, ep.identifier_resolution_confidence::text,
      COALESCE(ep.source_detail_row_id, parent.source_detail_row_id)::text AS source_detail_row_id,
      ep.order_id, ep.build_source, ep.tracking_number
     FROM public.expected_packages ep
     LEFT JOIN public.expected_packages parent ON parent.id = ep.parent_expected_package_id
     WHERE ep.build_source = ANY($3::text[])
       AND ep.organization_id = $4::uuid AND ep.store_id = $5::uuid
       AND ep.id > $1::uuid
     ORDER BY ep.id LIMIT $2`,
    [cursor, limit, RESOLVER_SOURCES, SAM_ORG, SAM_STORE],
  );
  return res.rows as RemovalExpectedPackageRow[];
}

async function fetchRemovalHydration(client: pg.Client, detailIds: string[]) {
  const out = new Map<string, { asin: string | null; upc: string | null }>();
  const CHUNK = 500;
  for (let i = 0; i < detailIds.length; i += CHUNK) {
    const slice = detailIds.slice(i, i + CHUNK);
    const r = await client.query(`SELECT id::text, raw_data FROM public.amazon_removals WHERE id = ANY($1::uuid[])`, [slice]);
    for (const row of r.rows) out.set(String(row.id), parseRemovalRawDataHints(row.raw_data));
  }
  return out;
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function resolveOne(
  supabase: ReturnType<typeof createClient>,
  pgClient: pg.Client,
  row: RemovalExpectedPackageRow,
  hydration: Map<string, { asin: string | null; upc: string | null }>,
): Promise<BackfillProposal> {
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
    if (await productExists(pgClient, after.resolved_product_id)) apply_kind = "set_resolved";
    else {
      after = { ...after, resolved_product_id: null, resolved_catalog_product_id: null, identifier_resolution_status: "unresolved" };
    }
  } else {
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

  return {
    id: row.id,
    organization_id: row.organization_id,
    store_id: n(row.store_id),
    order_id: n(row.order_id),
    build_source: n(row.build_source),
    tracking_number: n((row as { tracking_number?: string }).tracking_number),
    bucket: resolved.bucket,
    hints: { sku: resolved.hints.sku, fnsku: resolved.hints.fnsku, asin: resolved.hints.asin, upc: resolved.hints.upc },
    before,
    after,
    apply_kind,
  };
}

async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 32): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function applyProposals(client: pg.Client, proposals: BackfillProposal[]): Promise<number> {
  let applied = 0;
  for (const p of proposals.filter((x) => x.apply_kind !== "skip_unchanged")) {
    if (p.apply_kind === "set_resolved") {
      const r = await client.query(
        `UPDATE public.expected_packages t SET resolved_product_id=$2::uuid, resolved_catalog_product_id=$3::uuid,
         identifier_resolution_status=$4, identifier_resolution_confidence=$5, updated_at=now()
         FROM public.products pr WHERE t.id=$1::uuid AND pr.id=$2::uuid RETURNING t.id::text`,
        [p.id, p.after.resolved_product_id, p.after.resolved_catalog_product_id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
      );
      if (r.rowCount) applied += 1;
    } else {
      const r = await client.query(
        `UPDATE public.expected_packages SET resolved_product_id=NULL, resolved_catalog_product_id=NULL,
         identifier_resolution_status=$2, identifier_resolution_confidence=$3, updated_at=now()
         WHERE id=$1::uuid RETURNING id::text`,
        [p.id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
      );
      if (r.rowCount) applied += 1;
    }
  }
  return applied;
}

async function sampleProof(client: pg.Client) {
  const fnsku = await client.query(
    `SELECT ep.id::text, ep.fnsku, ep.sku, ep.tracking_number, ep.build_source,
      ep.resolved_product_id::text, ep.identifier_resolution_status,
      p.product_name
     FROM public.expected_packages ep
     LEFT JOIN public.products p ON p.id = ep.resolved_product_id
     WHERE ep.organization_id=$1::uuid AND ep.store_id=$2::uuid AND ep.fnsku=$3
     LIMIT 5`,
    [SAM_ORG, SAM_STORE, SAMPLE_FNSKU],
  );
  const tracking = await client.query(
    `SELECT ep.id::text, ep.fnsku, ep.sku, ep.tracking_number, ep.build_source,
      ep.resolved_product_id::text, ep.identifier_resolution_status,
      p.product_name
     FROM public.expected_packages ep
     LEFT JOIN public.products p ON p.id = ep.resolved_product_id
     WHERE ep.organization_id=$1::uuid AND ep.store_id=$2::uuid
       AND ep.tracking_number ILIKE '%' || $3 || '%'
     LIMIT 5`,
    [SAM_ORG, SAM_STORE, SAMPLE_TRACKING],
  );
  const viewSmoke = await client.query(
    `SELECT sku, fnsku, tracking_number, product_name, total_expected, total_scanned
     FROM public.v_inventory_item_status
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND (fnsku=$3 OR tracking_number ILIKE '%' || $4 || '%')
     LIMIT 5`,
    [SAM_ORG, SAM_STORE, SAMPLE_FNSKU, SAMPLE_TRACKING],
  );
  return { fnsku: fnsku.rows, tracking: tracking.rows, view_smoke: viewSmoke.rows };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (execute && !approval.approved) {
    blockers.push("APPROVED_TO_RUN_STAGING and APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL must be true");
  }
  for (const [label, path, key] of [
    ["allocation-fix", PREALLOC, "ok"],
    ["carrier-normalization", PRECARRIER, "ok"],
    ["receive-split", PRERECEIVE, "ok"],
  ] as const) {
    const m = loadPre<Record<string, unknown>>(path);
    if (!m || m[key] !== true) blockers.push(`${label} precondition PASS required (${path})`);
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || process.env.DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  if (!dbUrl || dbUrl.includes(ORIGINAL_REF)) blockers.push("Must not use original DB");
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF) || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging ref guard failed (${STAGING_REF})`);
  }
  const publicRef = refFromSupabaseUrl(publicUrl);
  if (!publicUrl || publicRef !== STAGING_REF) {
    blockers.push(`Supabase URL must target staging ${STAGING_REF}`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| APPROVED_TO_RUN_STAGING | ${approval.runStaging} |`,
      `| APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL | ${approval.backfill} |`,
      `| Execute | ${execute && approval.approved ? "yes" : "no"} |`,
    ].join("\n") + "\n",
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ status: "BLOCKED", blockers }, null, 2));
    console.log(JSON.stringify({ status: "BLOCKED", blockers }, null, 2));
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");
  const preCoverage = await probeCoverage(client);

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const allProposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const batch = await fetchCandidateRows(client, cursor, 500);
    if (!batch.length) break;
    const detailIds = [...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x))];
    const hydration = await fetchRemovalHydration(client, detailIds);
    allProposals.push(...(await mapPool(batch, (row) => resolveOne(supabase, client, row, hydration))));
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < 500) break;
  }

  const preimageRows = allProposals
    .filter((p) => p.apply_kind !== "skip_unchanged")
    .map((p) => ({ id: p.id, ...p.before }));

  let applied = 0;
  if (execute) applied = await applyProposals(client, allProposals);

  const postCoverage = execute ? await probeCoverage(client) : preCoverage;
  let samples: Awaited<ReturnType<typeof sampleProof>> = { fnsku: [], tracking: [], view_smoke: [] };
  try {
    samples = await sampleProof(client);
  } catch (e) {
    samples = { fnsku: [], tracking: [], view_smoke: [], error: e instanceof Error ? e.message : String(e) } as typeof samples;
  }
  await client.end();

  const unresolved = allProposals.filter((p) => p.bucket === "missing_product_needs_evidence");
  const ambiguous = allProposals.filter((p) => p.bucket === "ambiguous");
  const appliedRows = allProposals.filter((p) => p.apply_kind !== "skip_unchanged");

  const rollbackSql = preimageRows.map((r) => {
    const rp = r.resolved_product_id === null ? "NULL" : `'${r.resolved_product_id}'::uuid`;
    const rc = r.resolved_catalog_product_id === null ? "NULL" : `'${r.resolved_catalog_product_id}'::uuid`;
    const st = r.identifier_resolution_status === null ? "NULL" : `'${r.identifier_resolution_status}'`;
    const conf = r.identifier_resolution_confidence === null ? "NULL" : String(r.identifier_resolution_confidence);
    return `UPDATE public.expected_packages SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`;
  });

  fs.writeFileSync(
    path.join(outDir, "resolver-before-after.md"),
    [
      "# Resolver before / after",
      "",
      `| Metric | Before | After |`,
      `|--------|-------:|------:|`,
      `| Cohort total | ${preCoverage.cohort_total} | ${postCoverage.cohort_total} |`,
      `| Resolved | ${preCoverage.cohort_resolved} | ${postCoverage.cohort_resolved} |`,
      `| Unresolved | ${preCoverage.cohort_unresolved} | ${postCoverage.cohort_unresolved} |`,
      `| Ambiguous | ${preCoverage.cohort_ambiguous} | ${postCoverage.cohort_ambiguous} |`,
      `| Applied rows | — | ${applied} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "receive-allocated-coverage.md"),
    [
      "# receive_allocated coverage",
      "",
      `| Metric | Before | After |`,
      `|--------|-------:|------:|`,
      `| Total | ${preCoverage.receive_allocated_total} | ${postCoverage.receive_allocated_total} |`,
      `| Resolved | ${preCoverage.receive_allocated_resolved} | ${postCoverage.receive_allocated_resolved} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "applied-rows.json"), JSON.stringify(appliedRows, null, 2));
  fs.writeFileSync(path.join(outDir, "unresolved-rows.json"), JSON.stringify(unresolved, null, 2));
  fs.writeFileSync(path.join(outDir, "ambiguous-rows.json"), JSON.stringify(ambiguous, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), ["-- REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE rollback", ...rollbackSql].join("\n"));
  fs.writeFileSync(
    path.join(outDir, "sample-proof.md"),
    [
      "# Sample proof",
      "",
      `## FNSKU ${SAMPLE_FNSKU}`,
      "",
      "```json",
      JSON.stringify(samples.fnsku, null, 2),
      "```",
      "",
      `## Tracking ${SAMPLE_TRACKING}`,
      "",
      "```json",
      JSON.stringify(samples.tracking, null, 2),
      "```",
      "",
      "## v_inventory_item_status smoke",
      "",
      "```json",
      JSON.stringify(samples.view_smoke, null, 2),
      "```",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone.\n");

  const nextPrompt =
    "PC03D-EVIDENCE-QUEUE-FROM-REMOVAL-RESOLVER — refresh Amazon evidence queue for unresolved expected_packages after resolver backfill";

  const manifest = {
    prompt: "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    execute,
    applied,
    pre_coverage: preCoverage,
    post_coverage: postCoverage,
    dry_run: {
      resolved: allProposals.filter((p) => p.bucket === "resolved").length,
      unresolved: unresolved.length,
      ambiguous: ambiguous.length,
    },
    build_source_coverage: {
      detail_shipment: { total: postCoverage.detail_shipment_total, resolved: postCoverage.detail_shipment_resolved },
      detail_remainder: { total: postCoverage.detail_remainder_total, resolved: postCoverage.detail_remainder_resolved },
      receive_allocated: { total: postCoverage.receive_allocated_total, resolved: postCoverage.receive_allocated_resolved },
    },
    sample_proof: samples,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
