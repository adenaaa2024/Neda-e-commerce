/**
 * PC05 — Product packaging governed backfill dry-run (read-only, staging).
 *
 * Maps products.metadata.product_attributes + FBA volume reports into proposed
 * product_packaging_profiles / profile_versions. No DB writes, no Amazon API.
 *
 *   npx tsx scripts/pc05-product-packaging-governed-backfill-dry-run.ts
 *   npx tsx scripts/pc05-product-packaging-governed-backfill-dry-run.ts --run-id=20260523T220000Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run";
const PC04A_PROOF = "20260523T030000Z";

type Blocker =
  | "volume_only_no_lwh"
  | "pim_pack_structure_only"
  | "source_conflict_afi_mfba"
  | "profile_already_exists"
  | "missing_store_id"
  | "invalid_case_pack_parse"
  | "zero_volume";

type CandidateRow = {
  candidate_id: string;
  organization_id: string;
  store_id: string | null;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  packaging_level: string;
  fulfillment_context: string;
  source_type: string;
  source_table: string;
  source_row_id: string;
  length_value: string;
  width_value: string;
  height_value: string;
  dimension_unit: string;
  weight_value: string;
  weight_unit: string;
  units_per_case: string;
  units_per_inner_pack: string;
  cubic_volume: string;
  cubic_volume_unit: string;
  confidence_score: string;
  profile_status_proposed: string;
  blockers: string;
  recommended_action: "ready_for_execute" | "needs_operator_review" | "blocked";
  evidence_summary: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function profileKey(
  org: string,
  store: string | null,
  product: string,
  level: string,
  context: string,
): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function toCsv(rows: CandidateRow[]): string {
  const headers: (keyof CandidateRow)[] = [
    "candidate_id",
    "organization_id",
    "store_id",
    "product_id",
    "sku",
    "product_name",
    "packaging_level",
    "fulfillment_context",
    "source_type",
    "source_table",
    "source_row_id",
    "length_value",
    "width_value",
    "height_value",
    "dimension_unit",
    "weight_value",
    "weight_unit",
    "units_per_case",
    "units_per_inner_pack",
    "cubic_volume",
    "cubic_volume_unit",
    "confidence_score",
    "profile_status_proposed",
    "blockers",
    "recommended_action",
    "evidence_summary",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(String(row[h] ?? ""))).join(","));
  }
  return lines.join("\n") + "\n";
}

function parsePositiveInt(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function parseDimensions(raw: unknown): {
  length_value: number | null;
  width_value: number | null;
  height_value: number | null;
  dimension_unit: string | null;
} {
  if (raw == null) return { length_value: null, width_value: null, height_value: null, dimension_unit: null };
  const s = String(raw).trim();
  if (!s) return { length_value: null, width_value: null, height_value: null, dimension_unit: null };
  const jsonTry = (() => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (jsonTry && typeof jsonTry === "object") {
    const l = Number(jsonTry.length ?? jsonTry.l ?? jsonTry.L);
    const w = Number(jsonTry.width ?? jsonTry.w ?? jsonTry.W);
    const h = Number(jsonTry.height ?? jsonTry.h ?? jsonTry.H);
    const unit = String(jsonTry.unit ?? jsonTry.dimension_unit ?? "in").trim();
    if ([l, w, h].every((x) => Number.isFinite(x) && x > 0)) {
      return { length_value: l, width_value: w, height_value: h, dimension_unit: unit === "cm" ? "cm" : "in" };
    }
  }
  const m = s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    return {
      length_value: Number(m[1]),
      width_value: Number(m[2]),
      height_value: Number(m[3]),
      dimension_unit: /cm/i.test(s) ? "cm" : "in",
    };
  }
  return { length_value: null, width_value: null, height_value: null, dimension_unit: null };
}

function classifyAction(blockers: Blocker[]): CandidateRow["recommended_action"] {
  if (blockers.some((b) => b === "profile_already_exists" || b === "zero_volume")) return "blocked";
  if (blockers.length === 0) return "ready_for_execute";
  return "needs_operator_review";
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ref ${STAGING_REF}`);

  const pc04Proof = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc04a-product-packaging-schema-staging-apply",
    PC04A_PROOF,
    "manifest.json",
  );
  const pc04Ok =
    fs.existsSync(pc04Proof) &&
    (() => {
      try {
        const m = JSON.parse(fs.readFileSync(pc04Proof, "utf8")) as { applied?: boolean; ok?: boolean };
        return m.applied === true && m.ok === true;
      } catch {
        return false;
      }
    })();
  if (!pc04Ok) blockers.push(`PC04A staging schema proof missing: ${PC04A_PROOF}`);

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n"));
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ ok: false, run_id: runId, blockers, mode: "read_only_dry_run" }, null, 2),
    );
    console.log(JSON.stringify({ ok: false, outDir, blockers }, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const packagingTable = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='product_packaging_profiles'`,
  );
  if ((packagingTable.rowCount ?? 0) === 0) {
    await client.end();
    throw new Error("product_packaging_profiles missing — run PC04A first");
  }

  const existingProfiles = new Set<string>();
  const prof = await client.query(
    `SELECT organization_id, store_id, product_id, packaging_level, fulfillment_context
     FROM public.product_packaging_profiles`,
  );
  for (const r of prof.rows as {
    organization_id: string;
    store_id: string | null;
    product_id: string;
    packaging_level: string;
    fulfillment_context: string;
  }[]) {
    existingProfiles.add(
      profileKey(
        String(r.organization_id),
        r.store_id ? String(r.store_id) : null,
        String(r.product_id),
        String(r.packaging_level),
        String(r.fulfillment_context),
      ),
    );
  }

  const coverage: Record<string, number | string> = {};

  const afiRows = await client.query(
    `SELECT DISTINCT ON (f.resolved_product_id)
       f.id::text AS source_row_id,
       f.organization_id::text,
       f.store_id::text,
       f.resolved_product_id::text AS product_id,
       f.sku,
       f.product_name,
       f.item_volume,
       f.volume_unit_measurement,
       f.source_upload_id::text
     FROM public.amazon_fba_inventory f
     WHERE f.resolved_product_id IS NOT NULL
       AND f.item_volume IS NOT NULL
       AND f.item_volume > 0
     ORDER BY f.resolved_product_id, f.updated_at DESC NULLS LAST, f.created_at DESC`,
  );
  coverage.amazon_fba_inventory_volume_rows = afiRows.rowCount ?? 0;

  const mfbaRows = await client.query(
    `SELECT DISTINCT ON (f.resolved_product_id)
       f.id::text AS source_row_id,
       f.organization_id::text,
       f.store_id::text,
       f.resolved_product_id::text AS product_id,
       f.sku,
       f.product_name,
       f.per_unit_volume,
       f.source_upload_id::text
     FROM public.amazon_manage_fba_inventory f
     WHERE f.resolved_product_id IS NOT NULL
       AND f.per_unit_volume IS NOT NULL
       AND f.per_unit_volume > 0
     ORDER BY f.resolved_product_id, f.updated_at DESC NULLS LAST, f.created_at DESC`,
  );
  coverage.amazon_manage_fba_inventory_volume_rows = mfbaRows.rowCount ?? 0;

  const pimRows = await client.query(
    `SELECT
       p.id::text AS product_id,
       p.organization_id::text,
       p.store_id::text,
       p.sku,
       p.product_name,
       p.metadata->'product_attributes' AS pa
     FROM public.products p
     WHERE p.deleted_at IS NULL
       AND p.metadata->'product_attributes' IS NOT NULL
       AND p.metadata->'product_attributes' <> '{}'::jsonb`,
  );
  coverage.products_with_product_attributes = pimRows.rowCount ?? 0;

  const mfbaByProduct = new Map<string, { volume: number; source_row_id: string }>();
  for (const r of mfbaRows.rows as { product_id: string; per_unit_volume: string; source_row_id: string }[]) {
    mfbaByProduct.set(String(r.product_id), {
      volume: Number(r.per_unit_volume),
      source_row_id: String(r.source_row_id),
    });
  }

  const candidates: CandidateRow[] = [];
  let seq = 0;

  for (const r of afiRows.rows as Record<string, unknown>) {
    seq += 1;
    const org = String(r.organization_id);
    const store = r.store_id ? String(r.store_id) : null;
    const productId = String(r.product_id);
    const level = "unit";
    const context = "fba";
    const key = profileKey(org, store, productId, level, context);
    const rowBlockers: Blocker[] = ["volume_only_no_lwh"];
    if (!store) rowBlockers.push("missing_store_id");
    if (existingProfiles.has(key)) rowBlockers.push("profile_already_exists");

    const vol = Number(r.item_volume);
    const mfba = mfbaByProduct.get(productId);
    if (mfba && Math.abs(mfba.volume - vol) > 0.0001) rowBlockers.push("source_conflict_afi_mfba");

    candidates.push({
      candidate_id: `afi-${seq}`,
      organization_id: org,
      store_id: store,
      product_id: productId,
      sku: r.sku ? String(r.sku) : null,
      product_name: r.product_name ? String(r.product_name) : null,
      packaging_level: level,
      fulfillment_context: context,
      source_type: "amazon_report",
      source_table: "amazon_fba_inventory",
      source_row_id: String(r.source_row_id),
      length_value: "",
      width_value: "",
      height_value: "",
      dimension_unit: "",
      weight_value: "",
      weight_unit: "",
      units_per_case: "",
      units_per_inner_pack: "",
      cubic_volume: String(vol),
      cubic_volume_unit: String(r.volume_unit_measurement ?? "cubic feet"),
      confidence_score: rowBlockers.includes("source_conflict_afi_mfba") ? "0.55" : "0.75",
      profile_status_proposed: "needs_review",
      blockers: rowBlockers.join("|"),
      recommended_action: classifyAction(rowBlockers),
      evidence_summary: JSON.stringify({
        item_volume: vol,
        volume_unit: r.volume_unit_measurement,
        source_upload_id: r.source_upload_id ?? null,
        mfba_cross_check: mfba ?? null,
      }),
    });
  }

  for (const r of mfbaRows.rows as Record<string, unknown>) {
    const productId = String(r.product_id);
    if (candidates.some((c) => c.product_id === productId && c.source_table === "amazon_fba_inventory")) {
      continue;
    }
    seq += 1;
    const org = String(r.organization_id);
    const store = r.store_id ? String(r.store_id) : null;
    const level = "unit";
    const context = "fba";
    const key = profileKey(org, store, productId, level, context);
    const rowBlockers: Blocker[] = ["volume_only_no_lwh"];
    if (!store) rowBlockers.push("missing_store_id");
    if (existingProfiles.has(key)) rowBlockers.push("profile_already_exists");
    const vol = Number(r.per_unit_volume);

    candidates.push({
      candidate_id: `mfba-${seq}`,
      organization_id: org,
      store_id: store,
      product_id: productId,
      sku: r.sku ? String(r.sku) : null,
      product_name: r.product_name ? String(r.product_name) : null,
      packaging_level: level,
      fulfillment_context: context,
      source_type: "amazon_report",
      source_table: "amazon_manage_fba_inventory",
      source_row_id: String(r.source_row_id),
      length_value: "",
      width_value: "",
      height_value: "",
      dimension_unit: "",
      weight_value: "",
      weight_unit: "",
      units_per_case: "",
      units_per_inner_pack: "",
      cubic_volume: String(vol),
      cubic_volume_unit: "cubic feet",
      confidence_score: "0.70",
      profile_status_proposed: "needs_review",
      blockers: rowBlockers.join("|"),
      recommended_action: classifyAction(rowBlockers),
      evidence_summary: JSON.stringify({
        per_unit_volume: vol,
        source_upload_id: r.source_upload_id ?? null,
      }),
    });
  }

  const pimCandidateKeys = new Set<string>();
  for (const r of pimRows.rows as Record<string, unknown>) {
    const pa =
      r.pa && typeof r.pa === "object" && !Array.isArray(r.pa)
        ? (r.pa as Record<string, unknown>)
        : {};
    const casePack = parsePositiveInt(pa.case_pack);
    const packSize = parsePositiveInt(pa.pack_size);
    const dims = parseDimensions(pa.dimensions ?? pa.unit_size);
    const weightRaw = pa.weight ?? pa.item_weight ?? pa.package_weight;
    const hasDims = dims.length_value != null;
    const hasCase = casePack != null || packSize != null;
    if (!hasDims && !hasCase && !weightRaw) continue;

    const org = String(r.organization_id);
    const store = r.store_id ? String(r.store_id) : null;
    const productId = String(r.product_id);
    const level = hasDims || weightRaw ? "unit" : "case";
    const context = hasDims || weightRaw ? "unknown" : "wholesale";
    const key = profileKey(org, store, productId, level, context);
    if (pimCandidateKeys.has(key)) continue;
    pimCandidateKeys.add(key);

    const rowBlockers: Blocker[] = [];
    if (!hasDims && !weightRaw) rowBlockers.push("pim_pack_structure_only");
    else if (!hasDims) rowBlockers.push("volume_only_no_lwh");
    if (hasCase && casePack == null && pa.case_pack != null) rowBlockers.push("invalid_case_pack_parse");
    if (!store) rowBlockers.push("missing_store_id");
    if (existingProfiles.has(key)) rowBlockers.push("profile_already_exists");

    seq += 1;
    candidates.push({
      candidate_id: `pim-${seq}`,
      organization_id: org,
      store_id: store,
      product_id: productId,
      sku: r.sku ? String(r.sku) : null,
      product_name: r.product_name ? String(r.product_name) : null,
      packaging_level: level,
      fulfillment_context: context,
      source_type: "import",
      source_table: "products.metadata.product_attributes",
      source_row_id: productId,
      length_value: dims.length_value != null ? String(dims.length_value) : "",
      width_value: dims.width_value != null ? String(dims.width_value) : "",
      height_value: dims.height_value != null ? String(dims.height_value) : "",
      dimension_unit: dims.dimension_unit ?? "",
      weight_value: weightRaw != null ? String(weightRaw) : "",
      weight_unit: "",
      units_per_case: casePack != null ? String(casePack) : "",
      units_per_inner_pack: packSize != null ? String(packSize) : "",
      cubic_volume: "",
      cubic_volume_unit: "",
      confidence_score: hasDims ? "0.65" : hasCase ? "0.45" : "0.40",
      profile_status_proposed: rowBlockers.includes("pim_pack_structure_only") ? "needs_review" : "draft",
      blockers: rowBlockers.join("|"),
      recommended_action: classifyAction(rowBlockers),
      evidence_summary: JSON.stringify({
        product_attributes_keys: Object.keys(pa),
        case_pack: pa.case_pack ?? null,
        pack_size: pa.pack_size ?? null,
        data_quality: pa.data_quality ?? null,
      }),
    });
  }

  candidates.sort((a, b) => a.recommended_action.localeCompare(b.recommended_action) || a.product_id.localeCompare(b.product_id));

  const actionCounts = {
    ready_for_execute: candidates.filter((c) => c.recommended_action === "ready_for_execute").length,
    needs_operator_review: candidates.filter((c) => c.recommended_action === "needs_operator_review").length,
    blocked: candidates.filter((c) => c.recommended_action === "blocked").length,
  };

  fs.writeFileSync(path.join(outDir, "candidate-rows.csv"), toCsv(candidates));

  fs.writeFileSync(
    path.join(outDir, "mapping-rules.md"),
    [
      "# PC05 — Mapping rules (dry-run)",
      "",
      "## Sources",
      "",
      "| Source | Target profile | Fields mapped |",
      "|--------|----------------|---------------|",
      "| `amazon_fba_inventory` (latest per `resolved_product_id`) | `unit` + `fba` | `item_volume` → cubic_volume evidence; L×W×H empty (volume-only) |",
      "| `amazon_manage_fba_inventory` (fallback if no AFI row) | `unit` + `fba` | `per_unit_volume` → cubic_volume |",
      "| `products.metadata.product_attributes` | `unit`/`case` + `unknown`/`wholesale` | `dimensions`/`unit_size` → L×W×H; `case_pack`/`pack_size` → units_per_* |",
      "",
      "## Not mapped (forbidden in this dry-run)",
      "",
      "- No `UPDATE products` (legacy columns remain untouched)",
      "- No Amazon SP-API catalog calls",
      "- No auto-insert into packaging tables",
      "",
      "## Confidence defaults",
      "",
      "- AFI volume: 0.75 (0.55 if MFBA conflict)",
      "- MFBA-only volume: 0.70",
      "- PIM L×W×H parse: 0.65",
      "- PIM case_pack only: 0.45 (`needs_review`)",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "source-coverage.md"),
    [
      "# Source coverage — staging",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      ...Object.entries(coverage).map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "| Output candidates | **" + candidates.length + "** |",
      `| ready_for_execute | ${actionCounts.ready_for_execute} |`,
      `| needs_operator_review | ${actionCounts.needs_operator_review} |`,
      `| blocked | ${actionCounts.blocked} |`,
      "",
      "**Note:** Staging PIM `product_attributes` has widespread case/pack metadata but **0** rows with parseable `dimensions`/`weight` keys at dry-run time. Primary dimensional signal is FBA volume reports.",
    ].join("\n"),
  );

  const operatorBlockers = [
    "# PC05 — Operator blockers / review queues",
    "",
    "## Hard blockers (execute prompt must not auto-insert)",
    "",
    "- `profile_already_exists` — skip or supersede via governed execute",
    "- `zero_volume` — drop",
    "",
    "## Review queues",
    "",
    `- **volume_only_no_lwh** — ${candidates.filter((c) => c.blockers.includes("volume_only_no_lwh")).length} rows: cubic volume without L×W×H; claims fee math may need operator acceptance or catalog enrichment`,
    `- **pim_pack_structure_only** — ${candidates.filter((c) => c.blockers.includes("pim_pack_structure_only")).length} rows: case/pack counts only`,
    `- **source_conflict_afi_mfba** — ${candidates.filter((c) => c.blockers.includes("source_conflict_afi_mfba")).length} rows: AFI vs MFBA volume mismatch`,
    `- **missing_store_id** — ${candidates.filter((c) => c.blockers.includes("missing_store_id")).length} rows`,
    "",
    "## Next execute prompt (not this run)",
    "",
    "Separate approval-gated **PC05-EXECUTE** after operator filters `candidate-rows.csv` to accepted `candidate_id`s.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "blockers.md"), operatorBlockers);

  const ok = candidates.length > 0;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05 — PRODUCT PACKAGING GOVERNED BACKFILL DRY-RUN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        mode: "read_only_dry_run",
        pc04a_proof_run: PC04A_PROOF,
        candidate_count: candidates.length,
        action_counts: actionCounts,
        coverage,
        artifacts: ["candidate-rows.csv", "mapping-rules.md", "source-coverage.md", "blockers.md"],
        ok,
        next_prompt: "PC05-EXECUTE — PRODUCT PACKAGING BACKFILL STAGING APPLY (approval-gated; filtered candidate_ids only)",
        forbidden: { products_update: false, amazon_api: false, packaging_inserts: false },
      },
      null,
      2,
    ),
  );

  await client.end();

  console.log(
    JSON.stringify(
      {
        ok,
        outDir,
        candidate_count: candidates.length,
        action_counts: actionCounts,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
