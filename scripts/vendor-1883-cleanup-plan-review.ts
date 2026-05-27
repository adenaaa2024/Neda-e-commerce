/**
 * Vendor 1883 cleanup plan review (read-only)
 *
 *   npx tsx scripts/vendor-1883-cleanup-plan-review.ts --run-id=<UTC_Z>
 *   npx tsx scripts/vendor-1883-cleanup-plan-review.ts --census-run-id=20260528T010000Z
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
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const CENSUS_DEFAULT = "20260528T010000Z";
const CENSUS_BASE = ".cursor/audit-reports/spreadsheet-governed-import-plan";
const OUT_BASE = ".cursor/audit-reports/vendor-1883-cleanup-plan-review";
const APPROVAL = ".cursor/operator-approvals/vendor-1883-cleanup-staging-approval.md";

type Candidate = {
  product_id: string;
  seller_sku: string;
  current_vendor_name: string;
  proposed_vendor_name: string;
  sheet_row: number;
  sheet_brand: string;
  sheet_asin: string;
  note?: string;
};

type Classification =
  | "deterministic_update_safe"
  | "duplicate_sku_conflict"
  | "brand_mismatch"
  | "product_missing"
  | "manual_review";

type ReviewRow = Candidate & {
  classification: Classification;
  blockers: string[];
  live_sku: string | null;
  live_vendor_name: string | null;
  live_asin: string | null;
  duplicate_product_ids: string[];
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

function censusRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--census-run-id="));
  return a ? a.split("=")[1]!.trim() : CENSUS_DEFAULT;
}

function normSku(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

function isBare1883(v: string | null | undefined): boolean {
  return (v ?? "").trim() === "1883";
}

function brandStarts1883(brand: string | null | undefined): boolean {
  return /^1883\b/i.test((brand ?? "").trim());
}

function classifyRow(
  c: Candidate,
  live: { sku: string | null; vendor_name: string | null; asin: string | null } | undefined,
  dupIds: string[],
): ReviewRow {
  const blockers: string[] = [];
  if (c.proposed_vendor_name !== c.sheet_brand) {
    blockers.push("proposed_not_equal_sheet_brand");
  }
  if (!brandStarts1883(c.sheet_brand)) {
    blockers.push("sheet_brand_not_1883_prefix");
  }
  if (!isBare1883(c.current_vendor_name)) {
    blockers.push("census_current_not_bare_1883");
  }

  if (!live) {
    return {
      ...c,
      classification: "product_missing",
      blockers: [...blockers, "product_not_found_on_staging"],
      live_sku: null,
      live_vendor_name: null,
      live_asin: null,
      duplicate_product_ids: dupIds,
    };
  }

  if (dupIds.length > 0) {
    return {
      ...c,
      classification: "duplicate_sku_conflict",
      blockers: [...blockers, "duplicate_sku_active_products"],
      live_sku: live.sku,
      live_vendor_name: live.vendor_name,
      live_asin: live.asin,
      duplicate_product_ids: dupIds,
    };
  }

  if (blockers.some((b) => b.startsWith("proposed_") || b.startsWith("sheet_brand"))) {
    return {
      ...c,
      classification: "brand_mismatch",
      blockers,
      live_sku: live.sku,
      live_vendor_name: live.vendor_name,
      live_asin: live.asin,
      duplicate_product_ids: [],
    };
  }

  const skuMismatch = normSku(live.sku) !== normSku(c.seller_sku);
  const vendorChanged = !isBare1883(live.vendor_name);
  const asinMismatch =
    c.sheet_asin &&
    live.asin &&
    normSku(live.asin) !== normSku(c.sheet_asin.replace(/^B/i, "B"));

  if (skuMismatch) blockers.push("live_sku_mismatch");
  if (vendorChanged) blockers.push("live_vendor_already_updated");
  if (asinMismatch) blockers.push("live_asin_mismatch_sheet");

  if (
    !skuMismatch &&
    isBare1883(live.vendor_name) &&
    c.proposed_vendor_name === c.sheet_brand &&
    brandStarts1883(c.sheet_brand)
  ) {
    return {
      ...c,
      classification: "deterministic_update_safe",
      blockers: [],
      live_sku: live.sku,
      live_vendor_name: live.vendor_name,
      live_asin: live.asin,
      duplicate_product_ids: [],
    };
  }

  return {
    ...c,
    classification: "manual_review",
    blockers: blockers.length ? blockers : ["unclassified_edge"],
    live_sku: live.sku,
    live_vendor_name: live.vendor_name,
    live_asin: live.asin,
    duplicate_product_ids: [],
  };
}

function writeApproval(relPath: string, runId: string, deterministic: number): void {
  fs.writeFileSync(
    path.join(process.cwd(), relPath),
    `# Vendor 1883 cleanup — staging operator approval

**Scope:** Governed \`products.vendor_name\` UPDATE on **staging only** (\`${STAGING_REF}\`) — replace bare \`1883\` with spreadsheet \`Brand\` values starting with \`1883\`.

**Default:** not approved.

| Field | Value |
|-------|--------|
| Plan review | \`${OUT_BASE}/${runId}/\` |
| Deterministic rows | **${deterministic}** |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_VENDOR_1883_CLEANUP=false
\`\`\`

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging \`UPDATE products SET vendor_name = ...\` for deterministic plan rows only | Packaging table writes |
| Before/after audit JSON per run | \`product_identifier_map\` INSERT |
| Rollback script from execute audit | Original/current |
| | Product auto-create |
| | Amazon SP-API |

## Preconditions

- [ ] Review \`${OUT_BASE}/${runId}/vendor-1883-cleanup-review.md\`
- [ ] Review \`deterministic-update-plan.json\`
- [ ] Manual-review rows resolved or excluded

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_VENDOR_1883_CLEANUP=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const censusRunId = censusRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const candidatesPath = path.join(
    process.cwd(),
    CENSUS_BASE,
    censusRunId,
    "vendor-cleanup-candidates.json",
  );
  const candidates = JSON.parse(fs.readFileSync(candidatesPath, "utf8")) as Candidate[];

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) throw new Error("Staging guard failed");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const ids = candidates.map((c) => c.product_id);
  const liveRes = await client.query(
    `SELECT id::text, NULLIF(TRIM(sku),'') AS sku, NULLIF(TRIM(asin),'') AS asin,
            NULLIF(TRIM(vendor_name),'') AS vendor_name
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [SAM_ORG_ID, SAM_STORE_ID, ids],
  );

  const skuDupRes = await client.query(
    `SELECT UPPER(TRIM(sku)) AS sku_norm, array_agg(id::text ORDER BY id::text) AS product_ids
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND sku IS NOT NULL AND TRIM(sku) <> ''
     GROUP BY UPPER(TRIM(sku))
     HAVING COUNT(*) > 1`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );
  await client.end();

  const liveById = new Map(
    (liveRes.rows as Array<{ id: string; sku: string | null; asin: string | null; vendor_name: string | null }>).map(
      (r) => [r.id, r],
    ),
  );
  const dupBySku = new Map<string, string[]>();
  for (const r of skuDupRes.rows as Array<{ sku_norm: string; product_ids: string[] }>) {
    dupBySku.set(r.sku_norm, r.product_ids);
  }

  const reviewed: ReviewRow[] = candidates.map((c) => {
    const live = liveById.get(c.product_id);
    const skuNorm = normSku(c.seller_sku);
    const allForSku = dupBySku.get(skuNorm) ?? [];
    const dupIds = allForSku.filter((id) => id !== c.product_id);
    return classifyRow(
      c,
      live
        ? { sku: live.sku, vendor_name: live.vendor_name, asin: live.asin }
        : undefined,
      dupIds,
    );
  });

  const byClass = new Map<Classification, ReviewRow[]>();
  for (const r of reviewed) {
    const list = byClass.get(r.classification) ?? [];
    list.push(r);
    byClass.set(r.classification, list);
  }

  const deterministic = byClass.get("deterministic_update_safe") ?? [];
  const manual = reviewed.filter((r) => r.classification !== "deterministic_update_safe");
  const conflictCount =
    (byClass.get("duplicate_sku_conflict")?.length ?? 0) +
    (byClass.get("brand_mismatch")?.length ?? 0);

  const deterministicPlan = deterministic.map((r) => ({
    product_id: r.product_id,
    seller_sku: r.seller_sku,
    sheet_row: r.sheet_row,
    sheet_brand: r.sheet_brand,
    sheet_asin: r.sheet_asin,
    before_vendor_name: r.live_vendor_name ?? r.current_vendor_name,
    after_vendor_name: r.sheet_brand,
    proposed_vendor_name: r.proposed_vendor_name,
    brand_exact_match: r.proposed_vendor_name === r.sheet_brand,
    update_sql_hint: `UPDATE products SET vendor_name = '${r.sheet_brand.replace(/'/g, "''")}', updated_at = now() WHERE id = '${r.product_id}' AND btrim(vendor_name) = '1883'`,
  }));

  const rollbackLines = deterministic.map(
    (r) =>
      `UPDATE products SET vendor_name = '${(r.live_vendor_name ?? "1883").replace(/'/g, "''")}', updated_at = now() WHERE id = '${r.product_id}';`,
  );

  fs.writeFileSync(
    path.join(outDir, "deterministic-update-plan.json"),
    JSON.stringify({ run_id: runId, count: deterministicPlan.length, rows: deterministicPlan }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "manual-review-vendor-candidates.json"),
    JSON.stringify({ run_id: runId, count: manual.length, rows: manual }, null, 2),
  );

  const reviewMd = [
    "# Vendor 1883 cleanup plan review",
    "",
    `**Run id:** \`${runId}\` | **Census:** \`${CENSUS_BASE}/${censusRunId}/vendor-cleanup-candidates.json\``,
    `**Staging:** \`${STAGING_REF}\` | **Mode:** read-only (no DB writes)`,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "|--------|------:|",
    `| Census candidates | ${candidates.length} |`,
    `| deterministic_update_safe | **${deterministic.length}** |`,
    `| duplicate_sku_conflict | ${byClass.get("duplicate_sku_conflict")?.length ?? 0} |`,
    `| brand_mismatch | ${byClass.get("brand_mismatch")?.length ?? 0} |`,
    `| product_missing | ${byClass.get("product_missing")?.length ?? 0} |`,
    `| manual_review | ${byClass.get("manual_review")?.length ?? 0} |`,
    `| **Conflict total** (dup + brand) | **${conflictCount}** |`,
    "",
    "## Proposed value rule",
    "",
    "All deterministic rows set `vendor_name` **exactly** to `sheet_brand` (from spreadsheet `Brand` column).",
    `Unique sheet brands in census: **${[...new Set(candidates.map((c) => c.sheet_brand))].join("`, `")}**`,
    "",
    "## Sample deterministic rows",
    "",
    "| product_id | seller_sku | before | after (sheet_brand) | sheet_row |",
    "|------------|------------|--------|----------------------|----------:|",
    ...deterministic.slice(0, 8).map(
      (r) =>
        `| \`${r.product_id.slice(0, 8)}…\` | ${r.seller_sku} | ${r.live_vendor_name ?? "1883"} | ${r.sheet_brand} | ${r.sheet_row} |`,
    ),
    "",
    "## Manual / blocked cohorts",
    "",
    ...["duplicate_sku_conflict", "brand_mismatch", "product_missing", "manual_review"].map((cls) => {
      const rows = byClass.get(cls as Classification) ?? [];
      if (!rows.length) return `- **${cls}:** 0`;
      const sample = rows[0]!;
      return `- **${cls}:** ${rows.length} (e.g. \`${sample.product_id.slice(0, 8)}…\` blockers: ${sample.blockers.join(", ") || "—"})`;
    }),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "vendor-1883-cleanup-review.md"), `${reviewMd}\n`);

  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md"),
    [
      "# Rollback plan (deterministic cohort only)",
      "",
      `After governed execute, rollback **${deterministic.length}** rows:`,
      "",
      "```sql",
      "-- ILLUSTRATIVE — run from execute audit preimage when available",
      ...rollbackLines.slice(0, 5),
      deterministic.length > 5 ? `-- ... ${deterministic.length - 5} more rows in execute audit` : "",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only review; no `products` UPDATE.",
      `- ${manual.length} rows excluded from deterministic plan.`,
      `- ${byClass.get("duplicate_sku_conflict")?.length ?? 0} duplicate SKU conflicts need dedupe before update.`,
      `- Approval \`${APPROVAL}\` default false.`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_VENDOR_1883_CLEANUP=false",
      "```",
      "",
      `Deterministic rows when both flags true: **${deterministic.length}**`,
    ].join("\n") + "\n",
  );

  writeApproval(APPROVAL, runId, deterministic.length);

  const nextPrompt =
    deterministic.length > 0
      ? "VENDOR-1883-CLEANUP-STAGING-EXECUTE"
      : "VENDOR-1883-CLEANUP-MANUAL-RESOLUTION";

  const manifest = {
    prompt: "VENDOR 1883 CLEANUP PLAN REVIEW",
    run_id: runId,
    census_run_id: censusRunId,
    branch: execSync("git branch --show-current", { encoding: "utf8" }).trim(),
    staging_ref: STAGING_REF,
    status: "PASS",
    census_candidate_count: candidates.length,
    deterministic_update_count: deterministic.length,
    manual_review_count: manual.length,
    conflict_count: conflictCount,
    classification_counts: Object.fromEntries(
      [...byClass.entries()].map(([k, v]) => [k, v.length]),
    ),
    approval_file: APPROVAL,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
