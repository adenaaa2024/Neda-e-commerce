/**
 * PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-CONTRACT-V1 (read-only)
 *
 *   npx tsx scripts/phase-pc04-dimensions-history-evidence-contract-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-pc04-dimensions-history-evidence-contract-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function cols(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map(
    (x: { column_name: string; data_type: string; is_nullable: string }) =>
      `${x.column_name}:${x.data_type}${x.is_nullable === "NO" ? ":NOT_NULL" : ""}`,
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!dbUrl) throw new Error("Missing STAGING_DIRECT_POSTGRES_URL");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");
  await client.query("SET default_transaction_read_only = ON");

  const tables = [
    "product_packaging_profiles",
    "product_packaging_profile_versions",
    "product_packaging_dimensions_current",
    "product_packaging_evidence",
  ];

  const PC04_table_inventory: Record<string, unknown>[] = [];
  for (const t of tables) {
    const c = await cols(client, t);
    const cnt = await client.query(`SELECT count(*)::int AS n FROM public.${t}`);
    const orgCnt = c.some((x) => x.startsWith("organization_id:"))
      ? (
          await client.query(
            `SELECT count(*)::int AS n FROM public.${t} WHERE organization_id=$1::uuid`,
            [ORG],
          )
        ).rows[0]?.n
      : null;
    PC04_table_inventory.push({
      table: t,
      columns: c,
      total_rows: Number(cnt.rows[0]?.n ?? 0),
      org_rows: orgCnt != null ? Number(orgCnt) : null,
    });
  }

  const census = await client.query(`
    SELECT
      (SELECT count(*)::int FROM product_packaging_profiles) AS profiles,
      (SELECT count(*)::int FROM product_packaging_profile_versions) AS versions,
      (SELECT count(*)::int FROM product_packaging_dimensions_current) AS current,
      (SELECT count(*)::int FROM product_packaging_evidence) AS evidence,
      (SELECT count(*)::int FROM product_packaging_profile_versions WHERE profile_status = 'active') AS active_versions,
      (SELECT count(*)::int FROM product_packaging_profile_versions WHERE profile_status = 'needs_review') AS needs_review,
      (SELECT count(*)::int FROM product_packaging_profile_versions WHERE profile_status = 'superseded') AS superseded,
      (SELECT count(*)::int FROM product_packaging_profile_versions WHERE effective_to IS NOT NULL) AS with_effective_to,
      (SELECT count(*)::int FROM product_packaging_profile_versions WHERE superseded_by_version_id IS NOT NULL) AS with_superseded_by,
      (SELECT count(*)::int FROM product_packaging_profile_versions WHERE jsonb_typeof(evidence_summary) = 'object' AND evidence_summary <> '{}'::jsonb) AS versions_with_evidence_summary,
      (SELECT count(DISTINCT profile_id)::int FROM product_packaging_profile_versions) AS profiles_with_versions,
      (SELECT count(*)::int FROM (
         SELECT profile_id FROM product_packaging_profile_versions GROUP BY profile_id HAVING count(*) > 1
       ) x) AS profiles_multi_version,
      (SELECT count(*)::int FROM product_packaging_dimensions_current c
         LEFT JOIN product_packaging_profile_versions v ON v.id = c.current_version_id
         WHERE v.id IS NULL) AS orphan_current_version,
      (SELECT count(*)::int FROM product_packaging_dimensions_current c
         WHERE length_value IS NOT NULL AND width_value IS NOT NULL AND height_value IS NOT NULL) AS current_full_lwh,
      (SELECT count(*)::int FROM product_packaging_dimensions_current c
         WHERE weight_value IS NOT NULL) AS current_with_weight
  `);

  const sourceTypes = await client.query(`
    SELECT source_type, count(*)::int AS n
    FROM product_packaging_dimensions_current
    GROUP BY 1 ORDER BY n DESC
  `);

  const triggers = await client.query(`
    SELECT tgname, pg_get_triggerdef(oid) AS def
    FROM pg_trigger
    WHERE tgrelid = 'public.product_packaging_profile_versions'::regclass AND NOT tgisinternal
  `);

  const productStoryUsage = {
    pim_product_detail: "No dedicated packaging tab wired — products API may not hydrate PC04 yet",
    claim_center: "ClaimCenterDetailStoryBlocks ProductBlock — product linkage only; no dimension history block",
    product_linkage_contract: "ProductLinkageDisplayContract — packaging_summary[] planned in PC04 plan, not implemented",
    trid_discovery: "No trid_links target_kind for packaging_evidence yet",
  };

  const importPaths = [
    {
      path: "scripts/spreadsheet-packaging-import-staging-execute.ts",
      writes: "profiles + versions v1; evidence in evidence_summary jsonb; no product_packaging_evidence rows",
    },
    {
      path: "scripts/spreadsheet-packaging-activate-staging.ts",
      writes: "UPDATE profile_status needs_review→active; trigger refreshes dimensions_current",
    },
    {
      path: "scripts/pc05-product-packaging-backfill-staging-execute.ts",
      writes: "INSERT profiles/versions from governed dry-run CSV",
    },
    {
      path: "scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts",
      writes: "Catalog GET evidence cache files; PC04 evidence table insert not in dry-run path",
    },
    {
      path: "scripts/product-dimensions-spreadsheet-intake-audit.ts",
      writes: "read-only spreadsheet schema audit",
    },
  ];

  await client.end();

  const c = census.rows[0] as Record<string, number>;

  const current_vs_history_contract = {
    product_packaging_dimensions_current: {
      role: "Latest/current read model only — one row per profile_id (PK)",
      writer: "refresh_product_packaging_dimensions_current() trigger on active version only",
      reader_contract: "Claim Center fee tier, Product Story current dims, warehouse validation",
      must_not: "Direct INSERT/UPDATE by application except via trigger; never store history here",
    },
    product_packaging_profile_versions: {
      role: "Append-only historical dimension versions (immutable measurement payload)",
      writer: "INSERT new version_number on every measurement change; supersede prior via effective_to + superseded_by_version_id",
      reader_contract: "Point-in-time lookup: version effective_at <= claim event_date ORDER BY effective_from DESC",
      status_transitions: "UPDATE allowed only for profile_status / effective_to / superseded_by — not for L/W/H/weight after active",
    },
    product_packaging_evidence: {
      role: "Source/evidence/provenance artifacts linked to version_id",
      writer: "INSERT evidence row per api_payload, import_row, photo, measurement_ticket",
      reader_contract: "Claim filing packet + Product Story evidence panel",
    },
    product_packaging_profiles: {
      role: "Stable profile key: org + store + product_id + packaging_level + fulfillment_context",
      writer: "INSERT once per composite key; soft metadata updates only",
    },
  };

  const dimension_versioning_rules = [
    "Every dimension or weight change MUST INSERT a new product_packaging_profile_versions row with incremented version_number.",
    "Prior active version MUST set effective_to and profile_status=superseded before or atomically with new active version.",
    "dimensions_current updates ONLY via refresh trigger when new version profile_status=active AND effective_to IS NULL.",
    "Never UPDATE length_value/width_value/height_value/weight_value on an active version — create successor version instead.",
    "Activation of needs_review→active (spreadsheet path) is status-only UPDATE; measurement values frozen at insert time.",
    "Filing/immutable snapshot: copy version_id + dimension tuple into claim payload at promotion time (app layer).",
  ];

  const measuredByMap: Record<string, string> = {
    amazon_catalog_api: "amazon",
    amazon_report: "amazon",
    warehouse_measurement: "internal",
    manual: "manual",
    operator_override: "manual",
    import: "report",
  };

  const evidence_linking_contract = {
    required_link: "product_packaging_evidence.version_id → product_packaging_profile_versions.id",
    optional_pointers: {
      source_upload_id: "product_packaging_profile_versions.source_upload_id → raw_report_uploads",
      source_reference: "text lineage (spreadsheet row, report line)",
      evidence_summary: "jsonb on version — interim until evidence rows populated",
      source_table_source_row_id: "product_packaging_evidence polymorphic source pointer",
    },
    evidence_types: ["photo", "api_payload", "import_row", "operator_note", "measurement_ticket"],
    staging_today: {
      evidence_table_rows: c.evidence,
      versions_with_evidence_summary: c.versions_with_evidence_summary,
      gap: "Most provenance lives in evidence_summary jsonb; dedicated evidence table largely unused",
    },
  };

  const fee_claim_calculation_contract = {
    inputs: {
      canonical_dims: "product_packaging_dimensions_current WHERE packaging_level=unit AND fulfillment_context=fba",
      point_in_time_dims: "product_packaging_profile_versions WHERE effective_from <= event_date AND (effective_to IS NULL OR effective_to > event_date)",
      amazon_measured: "Future: SP-API evidence rows source_type amazon_catalog_api OR amazon_fee_preview.raw_data tier hints",
      charged_fee: "amazon_settlements.fba_fees / financial_reference_resolver / amazon_fee_preview.estimated_fee",
    },
    formulas: {
      dimensional_weight_lb:
        "max(weight_lb, (length_in * width_in * height_in) / divisor) — divisor from Amazon fee schedule at event_date",
      fee_tier: "Map dim_weight + longest_side to Amazon size tier table (schedule version locked per claim)",
      expected_fba_fee: "fee_schedule(tier, weight, category) — not stored; computed at audit time",
      observed_charged_fee: "Settlement/FRR row amount for SKU/FNSKU in window",
      overcharge_candidate: "observed_charged_fee - expected_fba_fee > tolerance AND dims confidence >= threshold",
    },
    evidence_package: [
      "product_packaging_profile_versions row (point-in-time)",
      "product_packaging_evidence api_payload or import_row",
      "raw_report_uploads / settlement line snapshot",
      "computed dim_weight worksheet in claim filing payload",
    ],
    immutability: "At claim promotion, embed packaging_version_id + frozen dim tuple in candidate_payload — do not re-read current if version superseded later",
  };

  const product_story_dimension_contract = {
    blocks: {
      current_dimensions: "Read product_packaging_dimensions_current grouped by fulfillment_context + packaging_level",
      dimension_history: "Timeline from product_packaging_profile_versions ORDER BY effective_from DESC with status badges",
      source_evidence: "Join product_packaging_evidence + evidence_summary + source_reference labels",
      fee_claim_risk: "Flag when amazon_report/internal dims disagree with fee tier implied by settlements (future compare widget)",
    },
    api_shape_recommended: {
      current: "packaging_current[]",
      history: "packaging_versions[] with version_id, effective_from, effective_to, source_type, confidence_score",
      evidence: "packaging_evidence[] with evidence_type, storage_url, source_table",
      risk: "packaging_fee_risk_flags[]",
    },
    staging_gap: "No unified /story or PIM packaging tab implemented yet",
  };

  const requiredFieldAudit = {
    product_id: { present: "profiles + dimensions_current", via: "product_id FK" },
    catalog_product_id: { present: false, gap: "Not on PC04 tables — join via product_identifier_map if needed" },
    identifiers: { present: "via products + map", gap: "Not denormalized on packaging rows" },
    length_width_height: { present: "versions + current", columns: "length_value, width_value, height_value, dimension_unit" },
    weight: { present: "weight_value, weight_unit" },
    package_type: { present: "packaging_level enum", maps_to: "unit|inner_pack|case|master_carton|pallet_load" },
    measured_by: {
      present: "partial via source_type",
      gap: "No measured_by column; map source_type→amazon|internal|manual|report; carrier missing from CHECK",
    },
    observed_at: { present: "partial", via: "effective_from (version); refreshed_at (current)", gap: "No separate observed_at" },
    effective_from: { present: true },
    source_kind: { present: "source_type + source_reference" },
    confidence: { present: "confidence_score" },
    evidence_reference: {
      present: "partial",
      via: "evidence_summary jsonb + product_packaging_evidence",
      gap: `${c.evidence} evidence rows vs ${c.versions} versions`,
    },
  };

  const gaps = [
    {
      id: "evidence_table_sparse",
      severity: "high",
      detail: `${c.evidence} evidence rows vs ${c.versions} versions; provenance mostly in evidence_summary jsonb`,
    },
    {
      id: "no_multi_version_history_yet",
      severity: "medium",
      detail: `${c.profiles_multi_version} profiles with >1 version — history model untested at scale`,
    },
    {
      id: "measured_by_carrier",
      severity: "medium",
      detail: "source_type CHECK lacks carrier; measured_by not first-class column",
    },
    {
      id: "catalog_product_id",
      severity: "low",
      detail: "PC04 uses product_id only; catalog spine join external",
    },
    {
      id: "observed_at",
      severity: "low",
      detail: "Use effective_from; add observed_at only if distinct from effective_from needed",
    },
    {
      id: "computed_dim_weight",
      severity: "medium",
      detail: "No view/materialization for dimensional weight — compute at claim read-model",
    },
    {
      id: "product_story_ui",
      severity: "medium",
      detail: "No packaging history UI or API wired",
    },
    {
      id: "version_update_risk",
      severity: "medium",
      detail: "GRANT UPDATE on versions — contract must forbid measurement UPDATE in app code + optional DB trigger guard",
    },
    {
      id: "amazon_raw_extraction",
      severity: "medium",
      detail: "products.amazon_raw has embedded Catalog dims but no normalized PC04 ingest pipeline live",
    },
    {
      id: "index_history_query",
      severity: "low",
      detail: "Add idx on (profile_id, effective_from DESC) for history timeline if missing",
    },
  ];

  const columns_needed_if_any = [
    {
      table: "product_packaging_profile_versions",
      column: "measured_by",
      type: "text CHECK IN (amazon, internal, carrier, manual, report)",
      optional: "Can derive from source_type via view instead",
    },
    {
      table: "product_packaging_profile_versions",
      column: "observed_at",
      type: "timestamptz",
      optional: "Only if observed != effective_from",
    },
    {
      table: "product_packaging_profiles",
      column: "catalog_product_id",
      type: "uuid nullable FK",
      optional: "Join via products sufficient for v1",
    },
  ];

  const migration_needed = c.evidence === 0 || gaps.some((g) => g.id === "measured_by_carrier") ? "conditional_yes" : "no";
  const new_table_needed = "no";

  const SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS = c.current >= 500 && c.orphan_current_version === 0 ? "yes" : "conditional_yes";

  const NEXT_EXACT_PROMPT = `PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-IMPLEMENT-V1
Mode: read-only design + optional additive migration draft only (no apply without Maysam approval).
Scope: (1) measured_by view mapping source_type; (2) evidence backfill plan evidence_summary→product_packaging_evidence; (3) packaging_version_immutability trigger blocking measurement UPDATE on active versions; (4) v_product_packaging_dim_weight read view; (5) Product Story API contract stub packaging_current/history/evidence; (6) claim filing packaging_snapshot embed rules.
Staging ref: ${STAGING_REF}; max 25-row evidence backfill pilot dry-run only.`;

  const outputs = {
    PC04_table_inventory,
    staging_census: { ...c, source_types: sourceTypes.rows },
    triggers: triggers.rows,
    import_code_paths: importPaths,
    product_story_usage_audit: productStoryUsage,
    current_vs_history_contract,
    dimension_versioning_rules,
    measured_by_source_type_map: measuredByMap,
    evidence_linking_contract,
    fee_claim_calculation_contract,
    product_story_dimension_contract,
    required_field_audit: requiredFieldAudit,
    gaps,
    migration_needed,
    new_table_needed,
    columns_needed_if_any,
    SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS,
    NEXT_EXACT_PROMPT,
  };

  for (const [key, val] of Object.entries(outputs)) {
    if (key === "NEXT_EXACT_PROMPT") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
    } else {
      fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
    }
  }

  const summary = [
    "# PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-CONTRACT-V1",
    "",
    `**Run:** \`${run}\` · **Staging:** \`${STAGING_REF}\` · **Read-only contract**`,
    "",
    "## PC04 inventory (staging)",
    "",
    "| Table | Rows |",
    "|-------|-----:|",
    `| profiles | ${c.profiles} |`,
    `| versions | ${c.versions} |`,
    `| dimensions_current | ${c.current} |`,
    `| evidence | ${c.evidence} |`,
    "",
    `- Multi-version profiles: **${c.profiles_multi_version}**`,
    `- Versions w/ evidence_summary: **${c.versions_with_evidence_summary}**`,
    `- Current w/ full L×W×H: **${c.current_full_lwh}**`,
    "",
    "## Contract verdict",
    "",
    `- **new_table_needed:** **no** — reuse PC04 stack`,
    `- **migration_needed:** **${migration_needed}** — optional measured_by view, evidence backfill, immutability guard`,
    `- **SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS:** **${SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS}**`,
    "",
    "## Key gap",
    "",
    "History model is **designed correctly** (versions + current + evidence) but **evidence table is nearly empty** — provenance lives in `evidence_summary` jsonb on versions. Financial Spine should extend PC04, not fork `product_dimensions_snapshots`.",
    "",
    "## Next prompt",
    "",
    "```text",
    NEXT_EXACT_PROMPT,
    "```",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "audit-summary.md"), summary);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-PC04-DIMENSIONS-HISTORY-EVIDENCE-CONTRACT-V1",
        run_id: run,
        staging_ref: STAGING_REF,
        read_only: true,
        migration_needed,
        new_table_needed,
        safe_to_use: SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, outDir, census: c, safe: SAFE_TO_USE_PC04_FOR_CLAIM_DIMENSIONS }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
