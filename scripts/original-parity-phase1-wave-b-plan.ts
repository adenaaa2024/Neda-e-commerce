/**
 * ORIGINAL-PARITY-PHASE1-WAVE-B-PLAN — product / map spine gap (read-only)
 *
 *   npx tsx scripts/original-parity-phase1-wave-b-plan.ts --run-id=<UTC_Z>
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
const OUT_BASE = ".cursor/audit-reports/original-parity-phase1-wave-b-plan";
const WAVE_B_APPROVAL = ".cursor/operator-approvals/original-parity-phase1-wave-b-approval.md";

/** Governed staging executes that touched product_identifier_map (map and/or product). */
const GOVERNED_EXECUTES = [
  {
    id: "E1_V192",
    match_sources: ["expected_packages_e1_map_bridge_v192"],
    script: "expected-packages-e1-map-bridge-execute-v192.ts",
    products: false,
    map_only: true,
    original_replay: "original-parity-wave-b-e1-map-replay",
  },
  {
    id: "E2_V194",
    match_sources: ["expected_packages_e2_product_promotion_v194"],
    script: "expected-packages-e2-product-promotion-execute-v194.ts",
    products: true,
    map_only: false,
    original_replay: "original-parity-wave-b-e2-product-promotion",
  },
  {
    id: "E1B_V198",
    match_sources: ["expected_packages_e1b_map_bridge_v198"],
    script: "expected-packages-e1b-map-bridge-execute-v198.ts",
    products: false,
    map_only: true,
    original_replay: "original-parity-wave-b-e1b-map-replay",
  },
  {
    id: "E1B_V200",
    match_sources: ["expected_packages_e1b_blocker_materialize_v200"],
    script: "expected-packages-e1b-blocker-materialize-execute-v200.ts",
    products: true,
    map_only: false,
    original_replay: "original-parity-wave-b-e1b-materialize",
  },
  {
    id: "PC03B",
    match_sources: ["expected_packages_pc03b_source_disagreement_map"],
    script: "pc03b-expected-packages-source-disagreement-map-execute.ts",
    products: false,
    map_only: true,
    original_replay: "original-parity-wave-b-pc03b-map-replay",
  },
  {
    id: "PC03EXEC",
    match_sources: ["expected_packages_pc03exec_dirty_source_map"],
    script: "pc03-exec-expected-packages-dirty-source-fix-execute.ts",
    products: false,
    map_only: true,
    original_replay: "original-parity-wave-b-pc03exec-map-replay",
  },
  {
    id: "PC03C",
    match_sources: ["expected_packages_pc03c_merge_duplicate_canonical"],
    script: "pc03c-expected-packages-merge-duplicate-canonical-execute.ts",
    products: false,
    map_only: true,
    original_replay: "original-parity-wave-b-pc03c-map-replay",
  },
  {
    id: "V202_EVIDENCE",
    match_sources: ["expected_packages_amazon_api_evidence_v202"],
    script: "expected-packages-amazon-api-evidence-execute-v202.ts",
    products: true,
    map_only: false,
    original_replay: "defer_original_api_evidence",
  },
] as const;

const GOVERNED_MATCH_SOURCES = new Set(
  GOVERNED_EXECUTES.flatMap((e) => [...e.match_sources]),
);

type GapClass =
  | "safe_replay"
  | "already_exists_under_different_key"
  | "conflict"
  | "unsafe_manual";

type ClassifiedRow = {
  staging_map_id: string;
  external_listing_id: string | null;
  match_source: string | null;
  product_id: string;
  seller_sku: string | null;
  fnsku: string | null;
  classification: GapClass;
  reason: string;
  governed_execute: string | null;
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

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function approvalWaveB(runId: string): string {
  return `# Original parity Phase 1 — Wave B product/PIM resolver data

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | Governed products + product_identifier_map spine deltas from staging |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_B=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_B=false
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
  if (!stagingUrl || !originalUrl) {
    blockers.push("Missing STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL");
  }
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) {
    blockers.push(`Staging URL must target ${STAGING_REF}`);
  }
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) {
    blockers.push(`Original URL must target ${ORIGINAL_REF}`);
  }
  if (stagingUrl && originalUrl && stagingUrl === originalUrl) {
    blockers.push("Staging and original URLs must differ");
  }

  let summary = {
    products_staging_active: 0,
    products_original_active: 0,
    map_staging_active: 0,
    map_original_active: 0,
    map_delta: 0,
    missing_on_original_by_external_listing_id: 0,
    safe_replay: 0,
    already_exists_under_different_key: 0,
    conflict: 0,
    unsafe_manual: 0,
  };

  let matchSourceStaging: Array<{ match_source: string; c: number }> = [];
  let matchSourceOriginal: Array<{ match_source: string; c: number }> = [];
  let governedDelta: Array<{ execute_id: string; staging_rows: number; original_rows: number; delta: number }> =
    [];
  let safeReplayPlan: Array<Record<string, unknown>> = [];
  let classifiedSample: ClassifiedRow[] = [];

  if (!blockers.length) {
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await staging.connect();
    await original.connect();
    await staging.query("SET statement_timeout = '180s'");
    await original.query("SET statement_timeout = '180s'");

    const countSnap = async (client: pg.Client, label: string) => {
      const products = await client.query(
        `SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`,
      );
      const map = await client.query(
        `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
      );
      const catalog = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name='catalog_products'
         ) AS ok`,
      );
      let catalogCount: number | null = null;
      if ((catalog.rows[0] as { ok: boolean }).ok) {
        const cr = await client.query(`SELECT COUNT(*)::int AS c FROM public.catalog_products`);
        catalogCount = (cr.rows[0] as { c: number }).c;
      }
      return {
        label,
        products_active: (products.rows[0] as { c: number }).c,
        map_active: (map.rows[0] as { c: number }).c,
        catalog_products: catalogCount,
      };
    };

    const stgSnap = await countSnap(staging, "staging");
    const orgSnap = await countSnap(original, "original");

    summary.products_staging_active = stgSnap.products_active;
    summary.products_original_active = orgSnap.products_active;
    summary.map_staging_active = stgSnap.map_active;
    summary.map_original_active = orgSnap.map_active;
    summary.map_delta = stgSnap.map_active - orgSnap.map_active;

    const ms = async (client: pg.Client) => {
      const r = await client.query(
        `SELECT COALESCE(match_source, '(null)') AS match_source, COUNT(*)::int AS c
         FROM public.product_identifier_map
         WHERE deleted_at IS NULL
         GROUP BY 1
         ORDER BY c DESC`,
      );
      return r.rows as Array<{ match_source: string; c: number }>;
    };
    matchSourceStaging = await ms(staging);
    matchSourceOriginal = await ms(original);

    for (const ex of GOVERNED_EXECUTES) {
      const stgC = matchSourceStaging
        .filter((r) => ex.match_sources.includes(r.match_source))
        .reduce((s, r) => s + r.c, 0);
      const orgC = matchSourceOriginal
        .filter((r) => ex.match_sources.includes(r.match_source))
        .reduce((s, r) => s + r.c, 0);
      governedDelta.push({
        execute_id: ex.id,
        staging_rows: stgC,
        original_rows: orgC,
        delta: stgC - orgC,
      });
    }

    const stgRows = await staging.query(
      `
      SELECT
        m.id::text AS staging_map_id,
        m.external_listing_id,
        m.match_source,
        m.product_id::text AS product_id,
        NULLIF(TRIM(m.seller_sku), '') AS seller_sku,
        NULLIF(TRIM(m.fnsku), '') AS fnsku
      FROM public.product_identifier_map m
      WHERE m.deleted_at IS NULL
        AND m.organization_id = $1::uuid
      `,
      [SAM_ORG],
    );

    const orgRows = await original.query(
      `
      SELECT
        m.id::text AS original_map_id,
        m.external_listing_id,
        m.match_source,
        m.product_id::text AS product_id,
        NULLIF(TRIM(m.seller_sku), '') AS seller_sku,
        NULLIF(TRIM(m.fnsku), '') AS fnsku
      FROM public.product_identifier_map m
      WHERE m.deleted_at IS NULL
        AND m.organization_id = $1::uuid
      `,
      [SAM_ORG],
    );

    const orgByExt = new Set(
      (orgRows.rows as Array<{ external_listing_id: string | null }>)
        .map((r) => r.external_listing_id)
        .filter(Boolean),
    );
    const orgProductIds = new Set(
      (await original.query(`SELECT id::text FROM public.products WHERE deleted_at IS NULL`)).rows.map(
        (r) => (r as { id: string }).id,
      ),
    );
    const orgByFnskuProduct = new Map<string, string>();
    for (const r of orgRows.rows as Array<{ fnsku: string | null; product_id: string }>) {
      if (r.fnsku) orgByFnskuProduct.set(r.fnsku, r.product_id);
    }

    const classified: ClassifiedRow[] = [];
    for (const row of stgRows.rows as ClassifiedRow[]) {
      if (row.external_listing_id && orgByExt.has(row.external_listing_id)) continue;

      const ms = row.match_source ?? "";
      const governed = GOVERNED_MATCH_SOURCES.has(ms);
      const execute = GOVERNED_EXECUTES.find((e) => e.match_sources.includes(ms))?.id ?? null;
      const productOnOriginal = orgProductIds.has(row.product_id);

      let classification: GapClass;
      let reason: string;

      if (!governed) {
        classification = "unsafe_manual";
        reason = "match_source not in governed Wave B replay list — manual triage";
      } else if (!productOnOriginal) {
        classification = "unsafe_manual";
        reason = `product_id ${row.product_id} missing on original — requires governed product promotion (E2/V200), not map copy`;
      } else if (
        row.fnsku &&
        orgByFnskuProduct.has(row.fnsku) &&
        orgByFnskuProduct.get(row.fnsku) !== row.product_id
      ) {
        classification = "conflict";
        reason = "FNSKU maps to different product_id on original";
      } else if (
        row.fnsku &&
        orgByFnskuProduct.has(row.fnsku) &&
        orgByFnskuProduct.get(row.fnsku) === row.product_id &&
        row.external_listing_id
      ) {
        classification = "already_exists_under_different_key";
        reason = "Same product reachable on original via FNSKU; different external_listing_id";
      } else if (governed && productOnOriginal) {
        classification = "safe_replay";
        reason = `Replay governed execute ${execute ?? ms} on original (map-only if flagged)`;
      } else {
        classification = "conflict";
        reason = "Unresolved spine mismatch";
      }

      classified.push({
        ...row,
        classification,
        reason,
        governed_execute: execute,
      });
    }

    summary.missing_on_original_by_external_listing_id = classified.length;
    summary.safe_replay = classified.filter((c) => c.classification === "safe_replay").length;
    summary.already_exists_under_different_key = classified.filter(
      (c) => c.classification === "already_exists_under_different_key",
    ).length;
    summary.conflict = classified.filter((c) => c.classification === "conflict").length;
    summary.unsafe_manual = classified.filter((c) => c.classification === "unsafe_manual").length;

    classifiedSample = classified.slice(0, 200);

    safeReplayPlan = GOVERNED_EXECUTES.map((ex) => ({
      execute_id: ex.id,
      match_sources: ex.match_sources,
      staging_script: ex.script,
      map_only: ex.map_only,
      creates_products: ex.products,
      original_rows_before: governedDelta.find((g) => g.execute_id === ex.id)?.original_rows ?? 0,
      staging_rows: governedDelta.find((g) => g.execute_id === ex.id)?.staging_rows ?? 0,
      delta: governedDelta.find((g) => g.execute_id === ex.id)?.delta ?? 0,
      wave_b_action:
        ex.map_only && !ex.products
          ? "replay_map_execute_on_original_with_same_plan_json"
          : ex.products
            ? "replay_product+map_execute_on_original_separate_sub_approval"
            : "defer",
      prompt: ex.original_replay,
      forbidden: ["bulk_insert_select_from_staging", "blind_copy"],
    }));

    await staging.end();
    await original.end();

    fs.writeFileSync(
      path.join(outDir, "wave-b-product-map-gap-report.md"),
      [
        "# Wave B — product / map spine gap report",
        "",
        `**Run:** \`${runId}\` | **Branch:** \`${branch}\``,
        "",
        "## Wave A baseline (operator-reported)",
        "",
        "- `expected_packages` resolver columns + `v_inventory_item_status` view parity: **PASS**",
        "- Scanner smoke on original: **PASS**",
        "",
        "## Active row counts",
        "",
        "| Surface | Staging | Original | Delta |",
        "|---------|--------:|---------:|------:|",
        `| \`products\` (deleted_at IS NULL) | ${summary.products_staging_active.toLocaleString()} | ${summary.products_original_active.toLocaleString()} | ${summary.products_staging_active - summary.products_original_active} |`,
        `| \`product_identifier_map\` (active) | ${summary.map_staging_active.toLocaleString()} | ${summary.map_original_active.toLocaleString()} | **${summary.map_delta}** |`,
        "",
        "## Classified staging map rows missing on original (by external_listing_id)",
        "",
        "| Classification | Count |",
        "|----------------|------:|",
        `| safe_replay | **${summary.safe_replay}** |`,
        `| already_exists_under_different_key | ${summary.already_exists_under_different_key} |`,
        `| conflict | ${summary.conflict} |`,
        `| unsafe_manual | ${summary.unsafe_manual} |`,
        `| **Total missing keys** | **${summary.missing_on_original_by_external_listing_id}** |`,
        "",
        "> Note: Total map delta (≈4,206) includes rows that share keys, legacy match_sources, and non-Sam org rows; classification above is Sam org spine keys only.",
        "",
        "## Governed execute delta (match_source cohort)",
        "",
        "| Execute | Staging rows | Original rows | Delta |",
        "|---------|-------------:|--------------:|------:|",
        ...governedDelta.map(
          (g) => `| ${g.execute_id} | ${g.staging_rows} | ${g.original_rows} | ${g.delta} |`,
        ),
        "",
        "## match_source — staging (top)",
        "",
        "| match_source | rows |",
        "|--------------|-----:|",
        ...matchSourceStaging.slice(0, 25).map((r) => `| \`${r.match_source}\` | ${r.c} |`),
        "",
        "## match_source — original (top)",
        "",
        "| match_source | rows |",
        "|--------------|-----:|",
        ...matchSourceOriginal.slice(0, 25).map((r) => `| \`${r.match_source}\` | ${r.c} |`),
        "",
        "## Policy",
        "",
        "- **Never** `INSERT INTO original ... SELECT FROM staging` for map/products.",
        "- Replay **governed plan JSON + execute scripts** with `ORIGINAL_DIRECT_POSTGRES_URL` and Wave B approval.",
        "- Map-only executes (E1, E1B map, PC03B) require `product_id` to already exist on original.",
        "- Product-creating executes (E2, E1B V200, V202) need sub-approvals and product parity checks first.",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(path.join(outDir, "safe-replay-plan.json"), JSON.stringify(safeReplayPlan, null, 2));

    const conflicts = classified.filter(
      (c) => c.classification === "conflict" || c.classification === "unsafe_manual",
    );
    fs.writeFileSync(
      path.join(outDir, "conflict-report.md"),
      [
        "# Conflict / unsafe manual report",
        "",
        `Sample of ${Math.min(100, conflicts.length)} rows (total conflict+unsafe: ${conflicts.length}).`,
        "",
        "| staging_map_id | match_source | product_id | class | reason |",
        "|----------------|--------------|------------|-------|--------|",
        ...conflicts.slice(0, 100).map(
          (c) =>
            `| \`${c.staging_map_id.slice(0, 8)}…\` | \`${c.match_source ?? "—"}\` | \`${c.product_id.slice(0, 8)}…\` | ${c.classification} | ${c.reason} |`,
        ),
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "rollback-plan.md"),
      [
        "# Rollback plan — Wave B",
        "",
        "Wave B inserts are **governed** and tagged by `match_source`. Rollback is per execute cohort:",
        "",
        "| Cohort | Rollback SQL (original only, after approval) |",
        "|--------|---------------------------------------------|",
        "| E1 V192 | `UPDATE product_identifier_map SET deleted_at = now() WHERE match_source = 'expected_packages_e1_map_bridge_v192' AND deleted_at IS NULL` |",
        "| E1B V198 | same pattern for `expected_packages_e1b_map_bridge_v198` |",
        "| PC03B | `expected_packages_pc03b_source_disagreement_map` |",
        "| E2 / V200 products | **Do not** soft-delete products without orphan check — rollback maps first; products only if zero references |",
        "",
        "## Preconditions",
        "",
        "- Snapshot `products` + `product_identifier_map` counts before execute.",
        "- Run in transaction per cohort with manifest `run_id`.",
        "- Never rollback staging from original execute.",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "classified-sample.json"),
      JSON.stringify(classifiedSample, null, 2),
    );
  }

  fs.writeFileSync(path.join(outDir, "approval-file.md"), [
    "# Approval file",
    "",
    `Canonical: [\`${WAVE_B_APPROVAL}\`](../../${WAVE_B_APPROVAL.replace(/\\/g, "/")})`,
    "",
    "Default flags remain **false** until operator sign-off.",
  ].join("\n") + "\n");

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : summary.unsafe_manual > 500
        ? `- High unsafe_manual count (${summary.unsafe_manual}) — triage non-governed match_sources before Wave B apply\n`
        : "- None for plan stage\n",
  );

  if (!fs.existsSync(path.join(process.cwd(), WAVE_B_APPROVAL))) {
    fs.writeFileSync(path.join(process.cwd(), WAVE_B_APPROVAL), approvalWaveB(runId));
  } else {
    const t = fs.readFileSync(path.join(process.cwd(), WAVE_B_APPROVAL), "utf8");
    if (!t.includes(runId) && t.includes("Plan run_id:")) {
      fs.writeFileSync(
        path.join(process.cwd(), WAVE_B_APPROVAL),
        t.replace(/Plan run_id:.*/, `Plan run_id: ${runId}`),
      );
    }
  }

  const nextPrompt =
    summary.safe_replay > 0
      ? "ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE-MAP-ONLY — replay E1/E1B/PC03B governed map executes on original (approval-gated)"
      : "ORIGINAL-PARITY-PHASE1-WAVE-B-TRIAGE — resolve unsafe_manual match_source cohorts before map replay";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "ORIGINAL-PARITY-PHASE1-WAVE-B-PLAN",
        run_id: runId,
        branch,
        mode: "read_only",
        db_touched: false,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        counts: summary,
        governed_execute_delta: governedDelta,
        classifications: {
          safe_replay: summary.safe_replay,
          already_exists_under_different_key: summary.already_exists_under_different_key,
          conflict: summary.conflict,
          unsafe_manual: summary.unsafe_manual,
        },
        approval_file: WAVE_B_APPROVAL,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: !blockers.length, outDir, ...summary, nextPrompt }, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
