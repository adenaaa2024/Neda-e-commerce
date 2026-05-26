/**
 * PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN
 *
 * Read-only: triage 38 dirty EP rows, propose source fixes from inventory spine,
 * preview post-fix map-only eligibility. No DB writes.
 *
 *   npx tsx scripts/pc03-expected-packages-dirty-source-quarantine-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc03-expected-packages-dirty-source-quarantine-plan";
const APPROVAL_PATH =
  ".cursor/operator-approvals/pc03-expected-packages-dirty-source-fix-execute-approval.md";
const PC03A_RUN = "20260523T040000Z";

type DirtyReason =
  | "asin_in_fnsku_field"
  | "unknow_sku"
  | "unknow_sku_with_x_fnsku"
  | "missing_store"
  | "test_placeholder";

type DirtyRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  build_source: string | null;
  order_id: string | null;
  dirty_reasons: DirtyReason[];
  misplaced_asin: string | null;
  inventory_proof: {
    distinct_product_ids: string[];
    sample_seller_sku: string | null;
    sample_fnsku: string | null;
    sample_product_name: string | null;
    proof_sources: string[];
  };
  proposed_fix: {
    sku: string | null;
    fnsku: string | null;
    fix_basis: string;
    confidence: "high" | "medium" | "low" | "none";
  };
  post_fix_map_only: {
    eligible: boolean;
    recommended_product_id: string | null;
    match_via: string[];
  };
  quarantine_action: "apply_proposed_fix" | "operator_manual" | "quarantine_exclude";
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

function isDirty(row: {
  sku: string | null;
  fnsku: string | null;
  store_id: string | null;
}): boolean {
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|UNKNOW)$/i.test(sku)) return true;
  if (/^(TEST|DUMMY)$/i.test(fnsku)) return true;
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) return true;
  return false;
}

function classifyDirtyReasons(row: {
  sku: string | null;
  fnsku: string | null;
  store_id: string | null;
}): DirtyReason[] {
  const reasons: DirtyReason[] = [];
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) reasons.push("missing_store");
  if (/^(TEST|DUMMY|PLACEHOLDER)$/i.test(sku) || /^(TEST|DUMMY)$/i.test(fnsku)) {
    reasons.push("test_placeholder");
  }
  if (/^(UNKNOWN|UNKNOW)$/i.test(sku)) reasons.push("unknow_sku");
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) reasons.push("asin_in_fnsku_field");
  if (/^(UNKNOWN|UNKNOW)$/i.test(sku) && /^X[0-9A-Z]{9,}$/.test(fnsku)) {
    reasons.push("unknow_sku_with_x_fnsku");
  }
  return reasons;
}

function isAsinLike(v: string | null): boolean {
  return !!v && /^B[0-9A-Z]{9}$/i.test(v.trim());
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error("Staging guard failed");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const coverageRes = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.*,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS read_bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE read_bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE read_bucket='unresolved')::int AS unresolved
    FROM classified
  `);

  const dirtyRes = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku,
        NULLIF(TRIM(e.build_source), '') AS build_source,
        NULLIF(TRIM(e.order_id), '') AS order_id,
        e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    unresolved AS (
      SELECT ep.*
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
      WHERE ep.resolved_product_id IS NULL
        AND COALESCE(mf.c,0)=0 AND COALESCE(ms.c,0)=0
        AND COALESCE(mf.c,0)<=1 AND COALESCE(ms.c,0)<=1
    ),
    inv_by_asin AS (
      SELECT u.id AS ep_id,
        src, pid::text, seller_sku, inv_fnsku, product_name
      FROM unresolved u
      CROSS JOIN LATERAL (
        SELECT 'inventory.asin'::text AS src,
          COALESCE(a.resolved_product_id, a.product_id) AS pid,
          NULLIF(TRIM(a.seller_sku), '') AS seller_sku,
          NULLIF(TRIM(a.fulfillment_channel_sku), '') AS inv_fnsku,
          NULL::text AS product_name
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE u.fnsku ~ '^B[0-9A-Z]{9}$' AND a.organization_id=u.organization_id AND a.store_id=u.store_id
          AND NULLIF(TRIM(a.asin),'') = u.fnsku
          AND COALESCE(a.resolved_product_id, a.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.asin', COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.sku), ''), NULLIF(TRIM(f.fnsku), ''), NULLIF(TRIM(f.product_name), '')
        FROM public.amazon_fba_inventory f
        WHERE u.fnsku ~ '^B[0-9A-Z]{9}$' AND f.organization_id=u.organization_id AND f.store_id=u.store_id
          AND NULLIF(TRIM(f.asin),'') = u.fnsku
          AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.asin', COALESCE(mf.resolved_product_id, mf.product_id),
          NULLIF(TRIM(mf.sku), ''), NULLIF(TRIM(mf.fnsku), ''), NULLIF(TRIM(mf.product_name), '')
        FROM public.amazon_manage_fba_inventory mf
        WHERE u.fnsku ~ '^B[0-9A-Z]{9}$' AND mf.organization_id=u.organization_id AND mf.store_id=u.store_id
          AND NULLIF(TRIM(mf.asin),'') = u.fnsku
          AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
      ) x
    ),
    inv_by_fnsku AS (
      SELECT u.id AS ep_id,
        src, pid::text, seller_sku, inv_fnsku, product_name
      FROM unresolved u
      CROSS JOIN LATERAL (
        SELECT 'inventory.fnsku'::text AS src,
          COALESCE(a.resolved_product_id, a.product_id) AS pid,
          NULLIF(TRIM(a.seller_sku), '') AS seller_sku,
          NULLIF(TRIM(a.fulfillment_channel_sku), '') AS inv_fnsku,
          NULL::text AS product_name
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE u.fnsku IS NOT NULL AND u.fnsku !~ '^B[0-9A-Z]{9}$'
          AND a.organization_id=u.organization_id AND a.store_id=u.store_id
          AND a.fulfillment_channel_sku = u.fnsku
          AND COALESCE(a.resolved_product_id, a.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.fnsku', COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.sku), ''), NULLIF(TRIM(f.fnsku), ''), NULLIF(TRIM(f.product_name), '')
        FROM public.amazon_fba_inventory f
        WHERE u.fnsku IS NOT NULL AND u.fnsku !~ '^B[0-9A-Z]{9}$'
          AND f.organization_id=u.organization_id AND f.store_id=u.store_id AND f.fnsku = u.fnsku
          AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.fnsku', COALESCE(mf.resolved_product_id, mf.product_id),
          NULLIF(TRIM(mf.sku), ''), NULLIF(TRIM(mf.fnsku), ''), NULLIF(TRIM(mf.product_name), '')
        FROM public.amazon_manage_fba_inventory mf
        WHERE u.fnsku IS NOT NULL AND u.fnsku !~ '^B[0-9A-Z]{9}$'
          AND mf.organization_id=u.organization_id AND mf.store_id=u.store_id AND mf.fnsku = u.fnsku
          AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
      ) x
    ),
    inv_agg AS (
      SELECT ep_id,
        COUNT(DISTINCT pid)::int AS distinct_pids,
        ARRAY_AGG(DISTINCT pid) AS pids,
        ARRAY_AGG(DISTINCT src) AS sources,
        MIN(seller_sku) AS sample_seller_sku,
        MIN(inv_fnsku) AS sample_fnsku,
        MIN(product_name) AS sample_product_name
      FROM (SELECT * FROM inv_by_asin UNION ALL SELECT * FROM inv_by_fnsku) all_inv
      GROUP BY ep_id
    )
    SELECT u.*, ia.distinct_pids, ia.pids, ia.sources, ia.sample_seller_sku, ia.sample_fnsku, ia.sample_product_name
    FROM unresolved u
    LEFT JOIN inv_agg ia ON ia.ep_id = u.id
    ORDER BY u.fnsku, u.sku, u.id
  `);

  await client.end();

  const coverage = coverageRes.rows[0] as Record<string, number>;
  const dirtyRows: DirtyRow[] = [];
  const clusterAsin = new Map<string, string[]>();

  for (const r of dirtyRes.rows as Record<string, unknown>[]) {
    const row = {
      sku: r.sku ? String(r.sku) : null,
      fnsku: r.fnsku ? String(r.fnsku) : null,
      store_id: r.store_id ? String(r.store_id) : null,
    };
    const dirtyReasons = classifyDirtyReasons(row);
    if (!isDirty(row)) continue;

    const misplacedAsin = isAsinLike(row.fnsku) ? row.fnsku!.trim().toUpperCase() : null;
    const pids = Array.isArray(r.pids) ? (r.pids as string[]) : [];
    const distinctPids = Number(r.distinct_pids ?? 0);
    const proofSources = Array.isArray(r.sources) ? (r.sources as string[]) : [];
    const sampleSku = r.sample_seller_sku ? String(r.sample_seller_sku) : null;
    const sampleFnsku = r.sample_fnsku ? String(r.sample_fnsku) : null;

    let proposedSku: string | null = null;
    let proposedFnsku: string | null = null;
    let fixBasis = "none";
    let confidence: DirtyRow["proposed_fix"]["confidence"] = "none";

    if (misplacedAsin && distinctPids === 1 && sampleSku && sampleFnsku) {
      proposedSku = sampleSku;
      proposedFnsku = sampleFnsku;
      fixBasis = `inventory_spine.asin=${misplacedAsin}`;
      confidence = "high";
    } else if (misplacedAsin && distinctPids === 1 && sampleSku) {
      proposedSku = sampleSku;
      proposedFnsku = sampleFnsku;
      fixBasis = `inventory_spine.asin=${misplacedAsin}_partial_fnsku`;
      confidence = sampleFnsku ? "high" : "medium";
    } else if (!misplacedAsin && row.fnsku && distinctPids === 1 && sampleSku) {
      proposedSku = sampleSku;
      proposedFnsku = row.fnsku;
      fixBasis = `inventory_spine.fnsku=${row.fnsku}`;
      confidence = "high";
    } else if (misplacedAsin && distinctPids === 1) {
      proposedFnsku = sampleFnsku;
      fixBasis = `inventory_spine.asin=${misplacedAsin}_product_only`;
      confidence = "medium";
    }

    const singlePid = distinctPids === 1 ? pids[0] ?? null : null;
    const postFixEligible =
      confidence === "high" &&
      !!singlePid &&
      !!(proposedSku || proposedFnsku) &&
      !(proposedFnsku && isAsinLike(proposedFnsku));

    let quarantine: DirtyRow["quarantine_action"] = "operator_manual";
    if (postFixEligible) quarantine = "apply_proposed_fix";
    else if (dirtyReasons.includes("test_placeholder")) quarantine = "quarantine_exclude";
    else if (!singlePid && !misplacedAsin && !row.fnsku?.startsWith("X")) quarantine = "quarantine_exclude";

    const epId = String(r.id);
    if (misplacedAsin) {
      const list = clusterAsin.get(misplacedAsin) ?? [];
      list.push(epId);
      clusterAsin.set(misplacedAsin, list);
    }

    dirtyRows.push({
      expected_package_id: epId,
      organization_id: String(r.organization_id),
      store_id: row.store_id,
      sku: row.sku,
      fnsku: row.fnsku,
      build_source: r.build_source ? String(r.build_source) : null,
      order_id: r.order_id ? String(r.order_id) : null,
      dirty_reasons: dirtyReasons,
      misplaced_asin: misplacedAsin,
      inventory_proof: {
        distinct_product_ids: pids,
        sample_seller_sku: sampleSku,
        sample_fnsku: sampleFnsku,
        sample_product_name: r.sample_product_name ? String(r.sample_product_name) : null,
        proof_sources: proofSources,
      },
      proposed_fix: {
        sku: proposedSku,
        fnsku: proposedFnsku,
        fix_basis: fixBasis,
        confidence,
      },
      post_fix_map_only: {
        eligible: postFixEligible,
        recommended_product_id: postFixEligible ? singlePid : null,
        match_via: postFixEligible ? proofSources : [],
      },
      quarantine_action: quarantine,
    });
  }

  const applyFix = dirtyRows.filter((r) => r.quarantine_action === "apply_proposed_fix");
  const manual = dirtyRows.filter((r) => r.quarantine_action === "operator_manual");
  const quarantine = dirtyRows.filter((r) => r.quarantine_action === "quarantine_exclude");
  const postFixMap = dirtyRows.filter((r) => r.post_fix_map_only.eligible);

  fs.writeFileSync(
    path.join(outDir, "dirty-rows-detail.json"),
    JSON.stringify({ run_id: runId, count: dirtyRows.length, rows: dirtyRows }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "proposed-source-fixes.json"),
    JSON.stringify(
      {
        run_id: runId,
        high_confidence_fixes: dirtyRows.filter((r) => r.proposed_fix.confidence === "high"),
        apply_on_execute: applyFix.map((r) => ({
          expected_package_id: r.expected_package_id,
          current: { sku: r.sku, fnsku: r.fnsku },
          proposed: { sku: r.proposed_fix.sku, fnsku: r.proposed_fix.fnsku },
          fix_basis: r.proposed_fix.fix_basis,
        })),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "post-fix-map-only-preview.json"),
    JSON.stringify(
      {
        run_id: runId,
        post_fix_map_only_eligible: postFixMap.length,
        note: "Re-run PC03A after governed source-fix execute to confirm exact map-only candidates",
        rows: postFixMap.map((r) => ({
          expected_package_id: r.expected_package_id,
          proposed_sku: r.proposed_fix.sku,
          proposed_fnsku: r.proposed_fix.fnsku,
          recommended_product_id: r.post_fix_map_only.recommended_product_id,
        })),
      },
      null,
      2,
    ),
  );

  const clusterMd = [
    "# ASIN-in-FNSKU clusters",
    "",
    `Distinct misplaced ASINs: **${clusterAsin.size}**`,
    "",
    "| misplaced_asin | EP row count | sample EP ids |",
    "|----------------|-------------:|---------------|",
    ...[...clusterAsin.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([asin, ids]) =>
          `| ${asin} | ${ids.length} | ${ids.slice(0, 3).map((x) => `\`${x.slice(0, 8)}…\``).join(", ")}${ids.length > 3 ? "…" : ""} |`,
      ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "cluster-map.md"), `${clusterMd}\n`);

  const summaryMd = [
    "# Dirty source cohort summary",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    "",
    "## Coverage",
    "",
    `| Total EP | Resolved | Unresolved |`,
    `|--------:|---------:|-----------:|`,
    `| ${coverage.total} | ${coverage.read_layer_resolved} | ${coverage.unresolved} |`,
    "",
    "## Dirty cohort",
    "",
    `- **Dirty rows:** ${dirtyRows.length}`,
    `- **High-confidence proposed fix:** ${dirtyRows.filter((r) => r.proposed_fix.confidence === "high").length}`,
    `- **Apply on execute:** ${applyFix.length}`,
    `- **Operator manual:** ${manual.length}`,
    `- **Quarantine/exclude:** ${quarantine.length}`,
    `- **Post-fix map-only preview:** ${postFixMap.length}`,
    "",
    "## Dirty reason breakdown",
    "",
    ...["asin_in_fnsku_field", "unknow_sku", "unknow_sku_with_x_fnsku", "missing_store", "test_placeholder"].map(
      (reason) => {
        const n = dirtyRows.filter((r) => r.dirty_reasons.includes(reason as DirtyReason)).length;
        return `- **${reason}:** ${n}`;
      },
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "dirty-cohort-summary.md"), `${summaryMd}\n`);

  fs.writeFileSync(
    path.join(outDir, "quarantine-vs-fix-matrix.md"),
    [
      "# Quarantine vs fix matrix",
      "",
      "| Action | Rows | Next step |",
      "|--------|-----:|-----------|",
      `| apply_proposed_fix | ${applyFix.length} | Governed UPDATE \`expected_packages.sku/fnsku\` then map-only wave |`,
      `| operator_manual | ${manual.length} | Operator confirms identifiers; no auto-fix |`,
      `| quarantine_exclude | ${quarantine.length} | Exclude from linkage waves until source import fixed |`,
      "",
      "**Rule:** expected_packages remains read-layer-only for linkage; source-fix updates identifiers only.",
      "Map inserts happen in a separate governed execute after PC03A re-run.",
    ].join("\n") + "\n",
  );

  const approvalContent = `# PC03 expected_packages dirty source fix — execute approval

**Default:** not approved. Required before governed source identifier UPDATE on dirty EP rows.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Allowed write | UPDATE \`expected_packages.sku\` / \`expected_packages.fnsku\` for approved rows in plan |
| Forbidden | product create; bulk \`resolved_product_id\` update; production/original |
| Plan | \`${OUT_BASE}/${runId}/\` |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_PC03_EXPECTED_PACKAGES_DIRTY_SOURCE_FIX=false
\`\`\`

## Scope

- Dirty cohort: **${dirtyRows.length}** rows
- High-confidence auto-fix candidates: **${applyFix.length}**
- Post-fix map-only preview: **${postFixMap.length}** (confirm via PC03A re-run)

## Preconditions

- [ ] Review \`proposed-source-fixes.json\`
- [ ] Operator confirms no ASIN/FNSKU swap regressions per cluster (\`cluster-map.md\`)
- [ ] Map-only execute is **separate** prompt after source fix + PC03A re-run

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_PC03_EXPECTED_PACKAGES_DIRTY_SOURCE_FIX=false
Approved by:
UTC date:
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), APPROVAL_PATH), approvalContent);

  fs.writeFileSync(
    path.join(outDir, "approval-files.md"),
    [
      "# Approval files",
      "",
      "| File | Purpose | Default | Rows |",
      "|------|---------|---------|-----:|",
      `| \`${APPROVAL_PATH}\` | source identifier UPDATE execute | false | ${applyFix.length} auto-fix |`,
      `| \`.cursor/operator-approvals/pc03a-expected-packages-source-fix-approval.md\` | prior PC03A stub | false | — |`,
      "",
      "Map-only approval remains separate after PC03A re-run.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "execute-prompts-next.md"),
    [
      "# Execute prompts (ordered)",
      "",
      applyFix.length > 0
        ? `1. **PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE** — ${applyFix.length} high-confidence rows; approval \`${APPROVAL_PATH}\``
        : "1. *(none)* No high-confidence auto-fix rows",
      `2. **PC03A — EXPECTED-RETURN-SLIP-MAP-ONLY-EXECUTE-PLAN** (re-run) — confirm post-fix map-only candidates`,
      postFixMap.length > 0
        ? `3. **PC03A-EXEC — EXPECTED-PACKAGES-MAP-ONLY-INSERT-EXECUTE** — after step 2 confirms ${postFixMap.length} preview rows`
        : "3. *(TBD)* Map-only count confirmed only after source fix + PC03A re-run",
      manual.length > 0 ? `4. **PC03C — EXPECTED-PACKAGES-DIRTY-MANUAL-QUEUE** — ${manual.length} operator_manual rows` : "",
      "",
      "**Recommended next:** `PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE` (after approval)",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only plan; no DB writes.",
      `- ${dirtyRows.length} dirty rows block map-only/backfill waves (PC03A found 0 candidates).`,
      `- ${manual.length} rows need operator manual — inventory spine did not yield unique high-confidence fix.`,
      "- expected_packages: no bulk `resolved_product_id` persist (read-layer-only).",
      "- Slip/return (18 rows): separate manual/resolver-on-save track.",
      `- PC03A reference run: \`pc03a-expected-return-slip-map-only-execute-plan/${PC03A_RUN}/\``,
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    output_dir: `${OUT_BASE}/${runId}`,
    coverage,
    dirty_row_count: dirtyRows.length,
    apply_proposed_fix_count: applyFix.length,
    operator_manual_count: manual.length,
    quarantine_exclude_count: quarantine.length,
    post_fix_map_only_preview: postFixMap.length,
    distinct_misplaced_asin_clusters: clusterAsin.size,
    approval_file: APPROVAL_PATH,
    pc03a_reference: `pc03a-expected-return-slip-map-only-execute-plan/${PC03A_RUN}`,
    safest_execute_prompt: "PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE",
    forbidden: { db_writes: false, product_create: false, resolved_product_id_bulk: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
