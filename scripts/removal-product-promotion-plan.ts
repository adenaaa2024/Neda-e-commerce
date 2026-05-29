/**
 * Removal product promotion plan — Amazon-evidence backed only (read-only).
 *
 *   npx tsx scripts/removal-product-promotion-plan.ts --run-id=<UTC_Z>
 *   npx tsx scripts/removal-product-promotion-plan.ts --sync-plan-run-id=20260527T203758Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { parseRemovalRawDataHints } from "../lib/removal/resolve-expected-package-product";
import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const SYNC_BASE = ".cursor/audit-reports/sp-api-removal-reports-sync-plan";
const DOMAIN_EXEC_BASE = ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute";
const OUT_BASE = ".cursor/audit-reports/removal-product-promotion-plan";
const APPROVAL = ".cursor/operator-approvals/removal-product-promotion-staging-approval.md";

type SourceCandidate = {
  source: string;
  sku: string | null;
  fnsku: string | null;
  order_id: string | null;
};

type Classification =
  | "promote_ready"
  | "needs_catalog_evidence"
  | "ambiguous"
  | "reject_unsafe";

type EnrichedCandidate = {
  candidate_key: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  title: string | null;
  report_sources: string[];
  order_ids: string[];
  removal_order_line_count: number;
  removal_shipment_line_count: number;
  map_matches: Array<{ product_id: string; match_via: string }>;
  existing_product_ids: string[];
  classification: Classification;
  blockers: string[];
  promotion_plan: Record<string, unknown> | null;
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

function syncRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--sync-plan-run-id="));
  if (a) return a.split("=")[1]!.trim();
  const dirs = fs
    .readdirSync(path.join(process.cwd(), SYNC_BASE), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  return dirs[0] ?? "20260527T203758Z";
}

function normSku(s: string | null | undefined): string {
  return (s ?? "").trim();
}

function isUnknowSku(s: string | null | undefined): boolean {
  return /^(UNKNOW|UNKNOWN)$/i.test(normSku(s));
}

function isAsinInFnsku(fnsku: string | null | undefined): boolean {
  return /^B[0-9A-Z]{9}$/i.test(normSku(fnsku));
}

function isValidAmazonFnsku(fnsku: string | null | undefined): boolean {
  return /^X[0-9A-Z]{9,}$/i.test(normSku(fnsku));
}

function isValidSellerSku(sku: string | null | undefined): boolean {
  const s = normSku(sku);
  return s.length > 0 && !isUnknowSku(s);
}

function candidateKey(sku: string | null, fnsku: string | null): string {
  return `${normSku(sku).toUpperCase()}|${normSku(fnsku).toUpperCase()}`;
}

function classify(row: Omit<EnrichedCandidate, "classification" | "blockers" | "promotion_plan">): {
  classification: Classification;
  blockers: string[];
  promotion_plan: Record<string, unknown> | null;
} {
  const blockers: string[] = [];
  const sku = normSku(row.sku);
  const fnsku = normSku(row.fnsku);

  if (!sku && !fnsku) {
    return { classification: "reject_unsafe", blockers: ["no_identifiers"], promotion_plan: null };
  }

  if (row.existing_product_ids.length > 0) {
    blockers.push(`product_already_exists:${row.existing_product_ids.join(",")}`);
    return { classification: "reject_unsafe", blockers, promotion_plan: null };
  }

  if (row.map_matches.length > 1) {
    const pids = [...new Set(row.map_matches.map((m) => m.product_id))];
    if (pids.length > 1) {
      return {
        classification: "ambiguous",
        blockers: [`multiple_map_products:${pids.join(",")}`],
        promotion_plan: null,
      };
    }
  }

  if (row.map_matches.length === 1) {
    blockers.push(`map_already_links_product:${row.map_matches[0]!.product_id}`);
    return { classification: "reject_unsafe", blockers, promotion_plan: null };
  }

  if (isUnknowSku(sku) && isAsinInFnsku(fnsku)) {
    return {
      classification: "reject_unsafe",
      blockers: ["asin_in_fnsku_field_dirty_source"],
      promotion_plan: null,
    };
  }

  if (isUnknowSku(sku) && isValidAmazonFnsku(fnsku)) {
    return {
      classification: "needs_catalog_evidence",
      blockers: ["unknow_sku_needs_catalog_get_for_asin_title"],
      promotion_plan: null,
    };
  }

  if (isValidSellerSku(sku) && isValidAmazonFnsku(fnsku) && row.title) {
    return {
      classification: "promote_ready",
      blockers: [],
      promotion_plan: {
        action: "create_product_and_map",
        seller_sku: sku,
        fnsku,
        asin: row.asin,
        product_name: row.title,
        evidence: {
          report_sources: row.report_sources,
          order_ids: row.order_ids,
          removal_order_lines: row.removal_order_line_count,
          removal_shipment_lines: row.removal_shipment_line_count,
        },
        guardrails: [
          "staging_only",
          "no_create_without_title",
          "map_insert_in_same_transaction_as_product",
          "rollback_from_preimage",
        ],
      },
    };
  }

  if (isValidSellerSku(sku) && isValidAmazonFnsku(fnsku) && !row.title) {
    return {
      classification: "needs_catalog_evidence",
      blockers: ["valid_sku_fnsku_missing_title_in_report"],
      promotion_plan: null,
    };
  }

  if (isUnknowSku(sku)) {
    return {
      classification: "needs_catalog_evidence",
      blockers: ["unknow_sku_insufficient_report_proof"],
      promotion_plan: null,
    };
  }

  return {
    classification: "reject_unsafe",
    blockers: ["insufficient_amazon_evidence_for_promotion"],
    promotion_plan: null,
  };
}

function writeApproval(runId: string, promoteReady: number): void {
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL),
    `# Removal product promotion — staging operator approval

**Scope:** Governed \`products\` INSERT + \`product_identifier_map\` INSERT for **Amazon removal report evidence-backed** candidates only (\`${STAGING_REF}\`).

**Default:** not approved.

| Field | Value |
|-------|--------|
| Plan review | \`${OUT_BASE}/${runId}/\` |
| Promote-ready rows | **${promoteReady}** |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_PRODUCT_PROMOTION=false
\`\`\`

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging product+map insert for \`promote-ready-candidates.json\` only | Blind create from title-only |
| Before/after audit JSON | Production / original |
| Rollback from execute preimage | UNKNOW / ASIN-in-fnsku rows |
| | Amazon API in same execute (separate approval) |

## Preconditions

- [ ] Review \`product-promotion-plan.md\`
- [ ] Review \`promote-ready-candidates.json\`
- [ ] \`needs-catalog-evidence.json\` handled via Catalog GET wave first

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_PRODUCT_PROMOTION=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

async function tableColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
}

function parseRawHints(raw: unknown): { asin: string | null; title: string | null } {
  const hints = parseRemovalRawDataHints(raw);
  let title: string | null = null;
  let asin = hints.asin;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
  if (obj) {
    const t =
      String(obj["product-name"] ?? obj.product_name ?? obj.title ?? obj["item-name"] ?? "").trim() ||
      null;
    if (t) title = t;
    const a = String(obj.asin ?? obj.ASIN ?? "").trim() || null;
    if (a) asin = a;
  }
  return { asin, title };
}

async function fetchRemovalEvidence(
  client: pg.Client,
  table: "amazon_removals" | "amazon_removal_shipments",
  cols: Set<string>,
  sku: string | null,
  fnsku: string | null,
): Promise<Array<Record<string, unknown>>> {
  const rawCol = cols.has("raw_data") ? "raw_data" : cols.has("raw_row") ? "raw_row" : null;
  const select = [
    "order_id",
    "sku",
    "fnsku",
    cols.has("asin") ? "asin" : null,
    cols.has("product_name") ? "product_name" : null,
    rawCol,
    "upload_id::text AS upload_id",
  ]
    .filter(Boolean)
    .join(", ");
  const r = await client.query(
    `SELECT ${select}
     FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(sku)) = upper(trim($3))
       AND ($4::text IS NULL OR $4 = '' OR upper(trim(fnsku)) = upper(trim($4)))
     LIMIT 50`,
    [ORG_ID, STORE_ID, sku ?? "", fnsku ?? ""],
  );
  return r.rows as Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const syncRunId = syncRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const syncPath = path.join(process.cwd(), SYNC_BASE, syncRunId, "product-promotion-needed.json");
  if (!fs.existsSync(syncPath)) throw new Error(`Missing ${syncPath}`);

  const raw = JSON.parse(fs.readFileSync(syncPath, "utf8")) as {
    count: number;
    candidates: SourceCandidate[];
  };

  const byKey = new Map<string, SourceCandidate[]>();
  for (const c of raw.candidates) {
    const key = candidateKey(c.sku, c.fnsku);
    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) throw new Error("Staging guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const removalCols = await tableColumns(client, "amazon_removals");
  const shipmentCols = await tableColumns(client, "amazon_removal_shipments");

  const enriched: EnrichedCandidate[] = [];

  for (const [key, sources] of byKey) {
    const [skuPart, fnskuPart] = key.split("|");
    const sku = skuPart || null;
    const fnsku = fnskuPart || null;

    const orderRows = await fetchRemovalEvidence(client, "amazon_removals", removalCols, sku, fnsku);
    const shipRows = await fetchRemovalEvidence(
      client,
      "amazon_removal_shipments",
      shipmentCols,
      sku,
      fnsku,
    );

    let asin: string | null = null;
    let title: string | null = null;
    const reportSources = new Set<string>();
    const orderIds = new Set<string>();

    for (const r of [...orderRows, ...shipRows]) {
      if (r.order_id) orderIds.add(String(r.order_id));
      if (r.upload_id) reportSources.add(String(r.upload_id));
      if (r.product_name && !title) title = String(r.product_name).trim();
      if (r.asin && !asin) asin = String(r.asin).trim();
      const raw = r.raw_data ?? r.raw_row;
      const parsed = parseRawHints(raw);
      if (parsed.title && !title) title = parsed.title;
      if (parsed.asin && !asin) asin = parsed.asin;
    }

    if (isAsinInFnsku(fnsku) && !asin) asin = fnsku;

    const mapRes = await client.query(
      `SELECT product_id::text, seller_sku, fnsku, msku
       FROM public.product_identifier_map
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND (
           ($3::text <> '' AND upper(trim(fnsku)) = upper(trim($3)))
           OR ($4::text <> '' AND (upper(trim(seller_sku)) = upper(trim($4)) OR upper(trim(msku)) = upper(trim($4))))
         )`,
      [ORG_ID, STORE_ID, fnsku ?? "", sku ?? ""],
    );

    const mapMatches = (mapRes.rows as Array<{ product_id: string; seller_sku: string | null; fnsku: string | null; msku: string | null }>).map(
      (m) => ({
        product_id: m.product_id,
        match_via: m.fnsku && fnsku && m.fnsku.toUpperCase() === fnsku.toUpperCase() ? "fnsku" : "sku",
      }),
    );

    const prodRes = await client.query(
      `SELECT id::text FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND (
           ($3::text <> '' AND upper(trim(sku)) = upper(trim($3)))
           OR ($4::text <> '' AND upper(trim(fnsku)) = upper(trim($4)))
           OR ($5::text <> '' AND upper(trim(asin)) = upper(trim($5)))
         )`,
      [ORG_ID, STORE_ID, sku ?? "", fnsku ?? "", asin ?? ""],
    );

    const base = {
      candidate_key: key,
      sku,
      fnsku,
      asin,
      title,
      report_sources: [...reportSources],
      order_ids: [...orderIds, ...sources.map((s) => s.order_id).filter(Boolean) as string[]].filter(
        (v, i, a) => a.indexOf(v) === i,
      ),
      removal_order_line_count: orderRows.length,
      removal_shipment_line_count: shipRows.length,
      map_matches: mapMatches,
      existing_product_ids: (prodRes.rows as Array<{ id: string }>).map((r) => r.id),
    };

    const { classification, blockers, promotion_plan } = classify(base);
    enriched.push({ ...base, classification, blockers, promotion_plan });
  }

  await client.end();

  const promoteReady = enriched.filter((r) => r.classification === "promote_ready");
  const needsCatalog = enriched.filter((r) => r.classification === "needs_catalog_evidence");
  const ambiguous = enriched.filter((r) => r.classification === "ambiguous");
  const reject = enriched.filter((r) => r.classification === "reject_unsafe");

  fs.writeFileSync(
    path.join(outDir, "promote-ready-candidates.json"),
    JSON.stringify({ run_id: runId, count: promoteReady.length, candidates: promoteReady }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "needs-catalog-evidence.json"),
    JSON.stringify({ run_id: runId, count: needsCatalog.length, candidates: needsCatalog }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "ambiguous-candidates.json"),
    JSON.stringify({ run_id: runId, count: ambiguous.length, candidates: ambiguous }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "product-promotion-plan.md"),
    [
      "# Removal product promotion plan (Amazon evidence only)",
      "",
      `**Run:** \`${OUT_BASE}/${runId}/\` | **Source:** \`${SYNC_BASE}/${syncRunId}/product-promotion-needed.json\``,
      `**Staging:** \`${STAGING_REF}\` | **Mode:** read-only plan — no product create`,
      "",
      "## Summary",
      "",
      "| Classification | Count |",
      "|----------------|------:|",
      `| Source promotion rows (order+shipment) | ${raw.count} |`,
      `| Unique sku/fnsku pairs | **${byKey.size}** |`,
      `| **promote_ready** | **${promoteReady.length}** |`,
      `| needs_catalog_evidence | ${needsCatalog.length} |`,
      `| ambiguous | ${ambiguous.length} |`,
      `| reject/unsafe | ${reject.length} |`,
      "",
      "## Promote-ready (execute when approved)",
      "",
      "| sku | fnsku | title | asin | order lines |",
      "|-----|-------|-------|------|------------:|",
      ...promoteReady.map(
        (r) =>
          `| ${r.sku ?? "—"} | ${r.fnsku ?? "—"} | ${(r.title ?? "—").slice(0, 48)} | ${r.asin ?? "—"} | ${r.removal_order_line_count + r.removal_shipment_line_count} |`,
      ),
      "",
      "## Needs Catalog GET first",
      "",
      ...needsCatalog.slice(0, 12).map((r) => `- \`${r.sku}|${r.fnsku}\` — ${r.blockers.join(", ")}`),
      needsCatalog.length > 12 ? `- … ${needsCatalog.length - 12} more in JSON` : "",
      "",
      "## Reject / unsafe (no promotion)",
      "",
      ...reject.slice(0, 10).map((r) => `- \`${r.sku}|${r.fnsku}\` — ${r.blockers.join(", ")}`),
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
      "APPROVED_REMOVAL_PRODUCT_PROMOTION=false",
      "```",
      "",
      `Promote-ready when both true: **${promoteReady.length}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only plan; no products INSERT.",
      `- ${needsCatalog.length} pairs need Catalog GET before promotion.`,
      `- ${reject.length} pairs rejected (dirty source / product exists / map exists).`,
      `- ${ambiguous.length} ambiguous pairs need operator review.`,
    ].join("\n") + "\n",
  );

  writeApproval(runId, promoteReady.length);

  const nextPrompt =
    promoteReady.length > 0
      ? "REMOVAL-PRODUCT-PROMOTION-STAGING-EXECUTE — apply promote-ready-candidates.json when approved"
      : needsCatalog.length > 0
        ? "REMOVAL-MISSING-PRODUCTS-AMAZON-EVIDENCE — Catalog GET for needs-catalog-evidence cohort"
        : "REMOVAL-PRODUCT-PROMOTION-REMEDIATION — resolve reject/ambiguous cohorts";

  const manifest = {
    prompt: "REMOVAL PRODUCT PROMOTION PLAN — AMAZON-EVIDENCE BACKED ONLY",
    run_id: runId,
    sync_plan_run_id: syncRunId,
    branch: execSync("git branch --show-current", { encoding: "utf8" }).trim(),
    staging_ref: STAGING_REF,
    source_candidate_rows: raw.count,
    unique_sku_fnsku_pairs: byKey.size,
    promote_ready_count: promoteReady.length,
    needs_catalog_evidence_count: needsCatalog.length,
    ambiguous_count: ambiguous.length,
    reject_unsafe_count: reject.length,
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
