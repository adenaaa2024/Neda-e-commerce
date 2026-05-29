/**
 * ORIGINAL-PARITY-PHASE1-WAVE-DATA-PLAN (read-only)
 *
 *   npx tsx scripts/original-parity-phase1-wave-data-plan.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/original-parity-phase1-wave-data-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/original-parity-phase1-wave-data-approval.md";
const SCHEMA_EXECUTE_MANIFEST =
  ".cursor/audit-reports/original-parity-phase1-wave-schema-execute/20260530T180000Z/manifest.json";

const GOVERNED_MAP_REPLAYS = [
  { id: "e1-map-bridge", script: "expected-packages-e1-map-bridge-execute-v192.ts", rows: 134, products: 0 },
  { id: "e2-promotion", script: "expected-packages-e2-product-promotion-execute-v194.ts", rows: 19, products: 19 },
  { id: "e1b-materialize", script: "expected-packages-e1b-blocker-materialize-execute-v200.ts", rows: 10, products: 10 },
  { id: "pc03b-disagreement", script: "pc03b-expected-packages-source-disagreement-map-execute.ts", rows: 6, products: 0 },
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

async function functionExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname=$1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function functionBody(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid LIMIT 1`,
    [name],
  );
  return (r.rows[0] as { def?: string } | undefined)?.def ?? null;
}

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, col],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function schemaWaveOk(client: pg.Client): Promise<{ ok: boolean; checks: Record<string, boolean> }> {
  const rebuild = await functionBody(client, "rebuild_expected_packages_from_removals");
  const checks = {
    grouped_rebuild: rebuild?.includes("allocation_group_key") ?? false,
    tracking_normalizer: await functionExists(client, "normalize_removal_tracking_operational"),
    carrier_normalizer: await functionExists(client, "normalize_removal_carrier_operational"),
    allocate_rpc: await functionExists(client, "allocate_expected_item_unit"),
    expected_item_id: await columnExists(client, "return_items", "expected_item_id"),
    ep_parent_col: await columnExists(client, "expected_packages", "parent_expected_package_id"),
    ep_resolver_col: await columnExists(client, "expected_packages", "resolved_product_id"),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

async function dataCensus(client: pg.Client): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};

  const q = async (sql: string, params: unknown[] = []) => {
    const r = await client.query(sql, params);
    return r.rows[0] as Record<string, number>;
  };

  const removals = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_removals WHERE organization_id=$1 AND store_id=$2`,
    [SAM_ORG, SAM_STORE],
  );
  out.amazon_removals = removals.c;

  const shipments = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_removal_shipments WHERE organization_id=$1 AND store_id=$2`,
    [SAM_ORG, SAM_STORE],
  );
  out.amazon_removal_shipments = shipments.c;

  const ep = await q(
    `
    SELECT
      COUNT(*)::int AS ep_total,
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS ep_derived,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ep_resolved,
      COUNT(*) FILTER (WHERE allocation_group_key IS NOT NULL)::int AS ep_with_group_key
    FROM public.expected_packages
    WHERE organization_id=$1 AND store_id=$2
    `,
    [SAM_ORG, SAM_STORE],
  );
  Object.assign(out, ep);

  const pim = await q(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`);
  out.pim_active = pim.c;

  const products = await q(`SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`);
  out.products_active = products.c;

  try {
    const uploads = await q(
      `
      SELECT
        COUNT(*)::int AS upload_total,
        COUNT(*) FILTER (WHERE report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT'))::int AS removal_api_uploads,
        COUNT(*) FILTER (WHERE report_type = 'REMOVAL_ORDER')::int AS removal_order_uploads,
        COUNT(*) FILTER (WHERE report_type = 'REMOVAL_SHIPMENT')::int AS removal_shipment_uploads
      FROM public.amazon_uploads
      WHERE organization_id=$1
      `,
      [SAM_ORG],
    );
    Object.assign(out, uploads);
  } catch {
    out.upload_total = null;
    out.removal_api_uploads = null;
  }

  try {
    const staging = await q(
      `SELECT COUNT(*)::int AS c FROM public.amazon_staging WHERE organization_id=$1`,
      [SAM_ORG],
    );
    out.amazon_staging_rows = staging.c;
  } catch {
    out.amazon_staging_rows = null;
  }

  return out;
}

function approvalContent(runId: string): string {
  return `# Original parity Phase 1 — Wave data (removal domain + resolver + rebuild)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | SP-API removal sync, expected_packages rebuild, resolver backfill — no blind clone |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA=false
Approved by:
UTC date:
Plan run_id: ${runId}
\`\`\`
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl || !originalUrl) blockers.push("Missing postgres URLs");
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) blockers.push(`Staging must be ${STAGING_REF}`);
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) blockers.push(`Original must be ${ORIGINAL_REF}`);

  let schemaOk = false;
  let schemaChecks: Record<string, boolean> = {};
  let stagingCounts: Record<string, number | null> = {};
  let originalCounts: Record<string, number | null> = {};
  let schemaManifestLoaded = false;
  let schemaManifestPass = false;

  const manifestPath = path.join(process.cwd(), SCHEMA_EXECUTE_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    schemaManifestLoaded = true;
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { smoke_pass?: boolean };
    schemaManifestPass = m.smoke_pass === true;
  }

  if (!blockers.length) {
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await staging.connect();
    await original.connect();
    await staging.query("SET statement_timeout = '120s'");
    await original.query("SET statement_timeout = '120s'");

    const schema = await schemaWaveOk(original);
    schemaOk = schema.ok;
    schemaChecks = schema.checks;
    if (!schemaOk) blockers.push("Original schema wave not fully applied — run Wave schema execute first");

    stagingCounts = await dataCensus(staging);
    originalCounts = await dataCensus(original);

    await staging.end();
    await original.end();
  }

  const delta = (k: string) => {
    const s = stagingCounts[k] ?? 0;
    const o = originalCounts[k] ?? 0;
    return s - o;
  };

  const recommendedStrategy =
    "fresh_sp_api_fetch_on_original_then_domain_sync_rebuild_resolver";

  const unsafeGaps = [
    {
      id: "pim_bulk_clone",
      surface: "product_identifier_map",
      delta: delta("pim_active"),
      reason: "Never bulk-copy ~4,206 map rows from staging; replay governed E1/E2/E1B/PC03B only.",
    },
    {
      id: "staging_upload_replay",
      surface: "amazon_uploads / amazon_staging blobs",
      reason: "Cross-ref upload_id replay ties to staging synthetic keys — use fresh SP-API fetch on original instead.",
    },
    {
      id: "ep_row_clone",
      surface: "expected_packages derived rows",
      delta: delta("ep_derived"),
      reason: "Rebuild from original domain data via rebuild_expected_packages_from_removals, not INSERT from staging.",
    },
  ];

  const gapCensus = [
    "# Original data gap census",
    "",
    `Run: \`${runId}\` · Sam org/store`,
    "",
    "## Schema wave prerequisite",
    "",
    `| Check | Status |`,
    `|-------|--------|`,
    `| Schema execute manifest (\`20260530T180000Z\`) | ${schemaManifestLoaded ? (schemaManifestPass ? "**PASS**" : "loaded, not pass") : "not found"} |`,
    ...Object.entries(schemaChecks).map(([k, v]) => `| ${k} | **${v ? "yes" : "no"}** |`),
    `| **Schema wave ready for data** | **${schemaOk ? "yes" : "no"}** |`,
    "",
    "## Data counts",
    "",
    "| Metric | Staging | Original | Delta |",
    "|--------|--------:|---------:|------:|",
    "| amazon_removals | " + (stagingCounts.amazon_removals ?? "—") + " | " + (originalCounts.amazon_removals ?? "—") + " | " + delta("amazon_removals") + " |",
    "| amazon_removal_shipments | " + (stagingCounts.amazon_removal_shipments ?? "—") + " | " + (originalCounts.amazon_removal_shipments ?? "—") + " | " + delta("amazon_removal_shipments") + " |",
    "| derived expected_packages | " + (stagingCounts.ep_derived ?? "—") + " | " + (originalCounts.ep_derived ?? "—") + " | " + delta("ep_derived") + " |",
    "| EP resolved_product_id | " + (stagingCounts.ep_resolved ?? "—") + " | " + (originalCounts.ep_resolved ?? "—") + " | " + delta("ep_resolved") + " |",
    "| EP allocation_group_key | " + (stagingCounts.ep_with_group_key ?? "—") + " | " + (originalCounts.ep_with_group_key ?? "—") + " | " + delta("ep_with_group_key") + " |",
    "| product_identifier_map (active) | " + (stagingCounts.pim_active ?? "—") + " | " + (originalCounts.pim_active ?? "—") + " | " + delta("pim_active") + " |",
    "| products (active) | " + (stagingCounts.products_active ?? "—") + " | " + (originalCounts.products_active ?? "—") + " | " + delta("products_active") + " |",
    "",
    "## Upload / raw availability",
    "",
    "| Metric | Staging | Original |",
    "|--------|--------:|---------:|",
    "| removal API uploads | " + (stagingCounts.removal_api_uploads ?? "—") + " | " + (originalCounts.removal_api_uploads ?? "—") + " |",
    "| REMOVAL_ORDER uploads | " + (stagingCounts.removal_order_uploads ?? "—") + " | " + (originalCounts.removal_order_uploads ?? "—") + " |",
    "| REMOVAL_SHIPMENT uploads | " + (stagingCounts.removal_shipment_uploads ?? "—") + " | " + (originalCounts.removal_shipment_uploads ?? "—") + " |",
    "| amazon_staging rows | " + (stagingCounts.amazon_staging_rows ?? "—") + " | " + (originalCounts.amazon_staging_rows ?? "—") + " |",
  ].join("\n");

  const replayStrategy = [
    "# Data replay strategy",
    "",
    "## Recommendation: **fresh SP-API fetch on original** (not staging upload replay)",
    "",
    "| Option | Verdict | Rationale |",
    "|--------|---------|-----------|",
    "| **A. Fresh SP-API fetch on original** | **RECOMMENDED** | Same live seller account; authoritative reports; idempotent upload keys per ref; no cross-env blob copy. |",
    "| B. Replay staging raw uploads to original | **NOT RECOMMENDED** | Upload IDs, staging rows, and content_sha256 are staging-scoped; risks drift and violates production clone policy. |",
    "| C. Bulk DML clone domain tables | **FORBIDDEN** | Never copy amazon_removals/shipments/EP rows from staging to original. |",
    "",
    "## Execute sequence on original (after data approval)",
    "",
    "1. **Fetch** — `sp-api-removal-reports-fetch-execute.ts` adapted for original ref (new approval: original SP-API fetch)",
    "2. **Domain sync** — mirror `sp-api-removal-reports-domain-sync-execute.ts` on original (order + shipment uploads → domain tables)",
    "3. **Rebuild** — `rebuild_expected_packages_from_removals(Sam org, store)` + post-rebuild duplicate remainder cleanup if needed",
    "4. **Verify** — `removal-rebuild-verify-and-resolver-dryrun.ts` against original → `rebuild_valid=yes`, mismatch=0",
    "5. **Resolver backfill** — `removal-expected-packages-resolver-backfill-execute.ts` on original (map-only, no product create)",
    "",
    "## Staging reference window",
    "",
    "Staging fetch PASS: `sp-api-removal-reports-fetch-execute/20260527T202818Z/` (order 1,649 + shipment 5,305 staging lines scope).",
    "Use same or wider window on original; consider `removal-9-month-backfill-fetch` approval if historical parity required.",
  ].join("\n");

  const mapPlan = [
    "# Product / map governed replay plan",
    "",
    "**Unsafe:** bulk copy " + delta("pim_active") + " map rows from staging.",
    "",
    "## Governed replays (dry-run on original first)",
    "",
    "| Pack | Script | Map rows | Products |",
    "|------|--------|----------|----------|",
    ...GOVERNED_MAP_REPLAYS.map(
      (g) => `| ${g.id} | \`scripts/${g.script}\` | ~${g.rows} | ~${g.products} |`,
    ),
    "",
    "## Order",
    "",
    "1. Run map replays **before** resolver backfill if resolver depends on new identifiers",
    "2. E2 promotion only where Amazon evidence exists (never title-only)",
    "3. PC07 dirty-source quarantine may block subset — triage first if resolver missing_evidence high",
    "",
    "**Gate:** resolver can resolve majority of derived EP SKUs on original without blind create.",
  ].join("\n");

  const rebuildPlan = [
    "# Expected rebuild plan (original)",
    "",
    "## Preconditions",
    "",
    "- Schema wave applied (**grouped rebuild** function present)",
    "- Domain tables populated via SP-API sync (not staging clone)",
    "",
    "## Steps",
    "",
    "1. Preimage derived EP rows for Sam org/store",
    "2. Optional: duplicate detail_remainder cleanup (pattern from `removal-rebuild-allocation-fix-execute`)",
    "3. `SELECT * FROM rebuild_expected_packages_from_removals($ORG, $STORE)`",
    "4. Post-rebuild dedupe pass if `obsolete_rows_deleted = 0` and duplicates reappear",
    "",
    "## Target counts (approximate after sync)",
    "",
    "| Metric | Staging now | Original now | Post-rebuild target |",
    "|--------|------------:|-------------:|--------------------:|",
    `| derived EP | ${stagingCounts.ep_derived ?? "—"} | ${originalCounts.ep_derived ?? "—"} | ≈ staging after same domain |`,
    `| allocation_group_key | ${stagingCounts.ep_with_group_key ?? "—"} | ${originalCounts.ep_with_group_key ?? "—"} | > 0 |`,
    "",
    "**Gate:** verify script `rebuild_valid=yes`, allocation mismatch = 0.",
  ].join("\n");

  const resolverPlan = [
    "# Resolver backfill plan (original)",
    "",
    "## Approval",
    "",
    "`.cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md`",
    "",
    "## Rules",
    "",
    "- Map-only updates to `expected_packages.resolved_product_id` quad",
    "- No `products.insert`, no `product_identifier_map.insert` in resolver pass",
    "- Run dry-run first; compare missing_evidence to staging baseline",
    "",
    "## Preconditions",
    "",
    "- Rebuild verify PASS on original",
    "- Governed map replays complete (Wave B subset) if missing_evidence > staging",
    "",
    "## Target",
    "",
    `| Metric | Staging | Original now |`,
    `|--------|--------:|-------------:|`,
    `| EP resolved | ${stagingCounts.ep_resolved ?? "—"} | ${originalCounts.ep_resolved ?? "—"} |`,
    "",
    "**Gate:** derived_resolved coverage > 95% or matches staging resolver dry-run proposal.",
  ].join("\n");

  const approvalFileDoc = [
    "# Approval file",
    "",
    `Path: \`${APPROVAL_PATH}\``,
    "",
    "```text",
    "APPROVED_TO_RUN_ORIGINAL=false",
    "APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA=false",
    "```",
    "",
    "Sub-approvals likely needed for execute:",
    "- Original SP-API removal fetch (new or extend sp-api-removal-shipment-fetch for original)",
    "- Original domain sync",
    "- removal-expected-packages-resolver-backfill (original target)",
  ].join("\n");

  const approvalPath = path.join(process.cwd(), APPROVAL_PATH);
  fs.writeFileSync(approvalPath, approvalContent(runId));

  fs.writeFileSync(path.join(outDir, "original-data-gap-census.md"), gapCensus + "\n");
  fs.writeFileSync(path.join(outDir, "data-replay-strategy.md"), replayStrategy + "\n");
  fs.writeFileSync(path.join(outDir, "product-map-governed-replay-plan.md"), mapPlan + "\n");
  fs.writeFileSync(path.join(outDir, "expected-rebuild-plan.md"), rebuildPlan + "\n");
  fs.writeFileSync(path.join(outDir, "resolver-backfill-plan.md"), resolverPlan + "\n");
  fs.writeFileSync(path.join(outDir, "approval-file.md"), approvalFileDoc + "\n");
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None.\n",
  );

  const nextPrompt = !schemaOk
    ? "ORIGINAL-PARITY-PHASE1-WAVE-SCHEMA-EXECUTE — schema prerequisite not met"
    : "ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE — SP-API fetch + domain sync + rebuild on original (approval-gated)";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "ORIGINAL-PARITY-PHASE1-WAVE-DATA-PLAN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        status: blockers.length ? "BLOCKED" : "PASS",
        schema_wave_applied: schemaOk,
        schema_checks: schemaChecks,
        recommended_strategy: recommendedStrategy,
        unsafe_gaps: unsafeGaps,
        staging_counts: stagingCounts,
        original_counts: originalCounts,
        approval_file: APPROVAL_PATH,
        exact_next_prompt: nextPrompt,
        no_db_writes: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        recommended_strategy: recommendedStrategy,
        unsafe_gaps: unsafeGaps.length,
        schema_wave_applied: schemaOk,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
