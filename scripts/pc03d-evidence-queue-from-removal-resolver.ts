/**
 * PC03D EVIDENCE QUEUE FROM REMOVAL RESOLVER (read-only)
 *
 * Converts removal resolver missing_product_needs_evidence rows into Amazon evidence queue plan.
 * No Amazon API. No DB writes.
 *
 *   npx tsx scripts/pc03d-evidence-queue-from-removal-resolver.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { parseRemovalRawDataHints } from "../lib/removal/resolve-expected-package-product";
import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/pc03d-evidence-queue-from-removal-resolver";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-missing-products-amazon-evidence-approval.md";
const RESOLVER_EXEC = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-execute/20260527T230000Z";

type QueueInput = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  order_id: string | null;
  build_source: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
};

type ApiReadiness =
  | "asin_ready"
  | "fnsku_ready"
  | "sku_only"
  | "ambiguous"
  | "junk_identifiers";

type EvidenceQueueRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  order_id: string | null;
  order_type: string | null;
  build_source: string | null;
  source_detail_row_id: string | null;
  source_shipment_row_id: string | null;
  tracking_number: string | null;
  disposition: string | null;
  expected_scan_quantity: number | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  asin_from_removal_raw: string | null;
  upc: string | null;
  api_readiness: ApiReadiness;
  planned_call_type: "catalog_get_by_asin" | "fba_inventory_by_fnsku" | "none";
  planned_primary_identifier: string | null;
  map_product_count_fnsku: number;
  map_product_count_sku: number;
  junk_reason: string | null;
  notes: string;
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

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isAsin(v: string | null): boolean {
  return !!v && /^B[0-9A-Z]{9}$/i.test(v.trim());
}

function isXFnsku(v: string | null): boolean {
  return !!v && /^X[0-9A-Z]{9,}$/i.test(v.trim());
}

function isDirtySku(sku: string | null): boolean {
  const s = (sku ?? "").trim().toUpperCase();
  return s === "" || s === "UNKNOW" || s === "UNKNOWN";
}

function isJunkOrderId(orderId: string | null): boolean {
  if (!orderId) return false;
  return !/^[0-9A-Z]{8,16}$/i.test(orderId.trim()) && orderId.length < 20;
}

function loadResolverQueue(): QueueInput[] {
  const p = path.join(process.cwd(), RESOLVER_EXEC, "queue-missing-product-needs-evidence.jsonl");
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const row = JSON.parse(line) as Record<string, unknown>;
    return {
      expected_package_id: String(row.expected_package_id),
      organization_id: String(row.organization_id),
      store_id: String(row.store_id),
      order_id: n(row.order_id),
      build_source: n(row.build_source),
      sku: n(row.sku),
      fnsku: n(row.fnsku),
      asin: n(row.asin),
      upc: n(row.upc),
    };
  });
}

function classifyRow(args: {
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  asinFromRemoval: string | null;
  mapFnskuCount: number;
  mapSkuCount: number;
  orderId: string | null;
}): Pick<
  EvidenceQueueRow,
  "api_readiness" | "planned_call_type" | "planned_primary_identifier" | "junk_reason" | "notes"
> {
  const asinCandidates = new Set<string>();
  if (isAsin(args.asin)) asinCandidates.add(args.asin!.toUpperCase());
  if (isAsin(args.asinFromRemoval)) asinCandidates.add(args.asinFromRemoval!.toUpperCase());

  const fnskuInAsinField = isAsin(args.fnsku) && !isXFnsku(args.fnsku);
  const dirtySku = isDirtySku(args.sku);
  const junkOrder = isJunkOrderId(args.orderId);

  if (args.mapFnskuCount > 1 || args.mapSkuCount > 1 || asinCandidates.size > 1) {
    return {
      api_readiness: "ambiguous",
      planned_call_type: "none",
      planned_primary_identifier: null,
      junk_reason: null,
      notes: `Map ambiguity fnsku=${args.mapFnskuCount} sku=${args.mapSkuCount} asins=${[...asinCandidates].join("|") || "none"}`,
    };
  }

  if (fnskuInAsinField || (dirtySku && !isXFnsku(args.fnsku) && !asinCandidates.size)) {
    return {
      api_readiness: "junk_identifiers",
      planned_call_type: "none",
      planned_primary_identifier: null,
      junk_reason: fnskuInAsinField
        ? `fnsku_column_contains_asin:${args.fnsku}`
        : dirtySku
          ? `dirty_sku:${args.sku ?? "null"}`
          : "no_usable_identifier",
      notes: junkOrder ? `Corrupted order_id ${args.orderId}; source identifier repair likely required before API` : "Identifier field pollution — repair source before SP-API",
    };
  }

  if (asinCandidates.size === 1) {
    const asin = [...asinCandidates][0]!;
    return {
      api_readiness: "asin_ready",
      planned_call_type: "catalog_get_by_asin",
      planned_primary_identifier: asin,
      junk_reason: null,
      notes: "Single ASIN candidate for catalog GET",
    };
  }

  if (isXFnsku(args.fnsku)) {
    return {
      api_readiness: "fnsku_ready",
      planned_call_type: "fba_inventory_by_fnsku",
      planned_primary_identifier: args.fnsku!.toUpperCase(),
      junk_reason: null,
      notes: dirtySku
        ? "Valid X-FNSKU; SKU is UNKNOW/dirty — use FBA inventory lookup first"
        : "Valid X-FNSKU for FBA inventory summaries lookup",
    };
  }

  if (!isDirtySku(args.sku)) {
    return {
      api_readiness: "sku_only",
      planned_call_type: "none",
      planned_primary_identifier: args.sku,
      junk_reason: null,
      notes: "Seller SKU only — no catalog ASIN or X-FNSKU; blocked for standard PC03D path",
    };
  }

  return {
    api_readiness: "junk_identifiers",
    planned_call_type: "none",
    planned_primary_identifier: null,
    junk_reason: "no_usable_identifier",
    notes: "No ASIN, X-FNSKU, or clean SKU",
  };
}

async function spApiConfigured(client: pg.Client, orgId: string, storeId: string): Promise<boolean> {
  const storeRes = await client.query(
    `SELECT m.provider, m.credentials
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [storeId, orgId],
  );
  const store = storeRes.rows[0] as { provider?: string; credentials?: unknown } | undefined;
  if (
    store?.credentials &&
    typeof store.credentials === "object" &&
    store.provider === "amazon_sp_api" &&
    amazonSpCredentialsLookComplete(store.credentials as Record<string, unknown>)
  ) {
    return true;
  }
  const keyRes = await client.query(
    `SELECT 1 FROM public.organization_api_keys
     WHERE organization_id = $1::uuid AND name = 'amazon_sp_api' LIMIT 1`,
    [orgId],
  );
  return keyRes.rowCount === 1;
}

function writeApprovalFile(queueCount: number, apiReadyCount: number, runId: string): void {
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_PATH),
    `# Removal missing products — Amazon evidence dry-run

Supabase project ref/name: ${STAGING_REF}
Environment: staging
Approved by:
Approved at UTC:

APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_MISSING_PRODUCTS_AMAZON_EVIDENCE=false

## Scope

- Staging only (\`${STAGING_REF}\`)
- Evidence queue rows: **${queueCount}** (from removal resolver missing_product_needs_evidence)
- API-ready rows (asin_ready + fnsku_ready): **${apiReadyCount}**
- Plan: \`${OUT_BASE}/${runId}/\`
- Mode: SP-API catalog / FBA inventory evidence dry-run only
- No product create, no map insert, no expected_packages update

## Explicit exclusions

- [ ] No production / original (\`kxsvedvpjldygtdbylsy\`)
- [ ] No DB writes in dry-run
- [ ] No product auto-create
- [ ] No \`product_identifier_map.insert\`

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Removal resolver execute reviewed: \`${RESOLVER_EXEC}\` | |
| Junk identifier rows excluded or source-repaired first | |
| SP-API credentials present on staging store | |

## Sign-off

\`\`\`
Environment: STAGING ONLY
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_MISSING_PRODUCTS_AMAZON_EVIDENCE=true
Approved by:
UTC date:
Max API calls:
Notes:
\`\`\`
`,
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const inputQueue = loadResolverQueue();
  if (inputQueue.length !== 24) {
    blockers.push(`Expected 24 missing_product_needs_evidence rows, got ${inputQueue.length}`);
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push(`Staging DB guard failed (expected ${STAGING_REF})`);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) {
    blockers.push("Supabase URL guard failed");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const ids = inputQueue.map((r) => r.expected_package_id);
  const epRes = await client.query(
    `SELECT
      ep.id::text,
      ep.organization_id::text,
      ep.store_id::text,
      ep.order_id,
      ep.order_type,
      ep.build_source,
      ep.source_detail_row_id::text,
      ep.source_shipment_row_id::text,
      ep.tracking_number,
      ep.disposition,
      ep.expected_scan_quantity,
      ep.sku,
      ep.fnsku,
      ar.raw_data AS removal_raw_data,
      ars.tracking_number AS shipment_tracking,
      ars.carrier AS shipment_carrier
     FROM public.expected_packages ep
     LEFT JOIN public.amazon_removals ar ON ar.id = ep.source_detail_row_id
     LEFT JOIN public.amazon_removal_shipments ars ON ars.id = ep.source_shipment_row_id
     WHERE ep.id = ANY($1::uuid[])`,
    [ids],
  );

  const epById = new Map<string, Record<string, unknown>>();
  for (const row of epRes.rows) epById.set(String(row.id), row as Record<string, unknown>);

  const queue: EvidenceQueueRow[] = [];
  for (const input of inputQueue) {
    const ep = epById.get(input.expected_package_id) ?? {};
    const sku = n(ep.sku) ?? input.sku;
    const fnsku = n(ep.fnsku) ?? input.fnsku;
    const rawHints = parseRemovalRawDataHints(ep.removal_raw_data);
    const asinFromRemoval = rawHints.asin;

    let mapFnskuCount = 0;
    let mapSkuCount = 0;
    if (fnsku) {
      const mf = await client.query(
        `SELECT COUNT(DISTINCT product_id)::int AS c FROM public.product_identifier_map
         WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL AND fnsku=$3`,
        [input.organization_id, input.store_id, fnsku],
      );
      mapFnskuCount = Number(mf.rows[0]?.c ?? 0);
    }
    if (sku && !isDirtySku(sku)) {
      const ms = await client.query(
        `SELECT COUNT(DISTINCT product_id)::int AS c FROM public.product_identifier_map
         WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
           AND (seller_sku=$3 OR msku=$3)`,
        [input.organization_id, input.store_id, sku],
      );
      mapSkuCount = Number(ms.rows[0]?.c ?? 0);
    }

    const classified = classifyRow({
      sku,
      fnsku,
      asin: n(ep.asin) ?? input.asin,
      asinFromRemoval,
      mapFnskuCount,
      mapSkuCount,
      orderId: n(ep.order_id) ?? input.order_id,
    });

    queue.push({
      expected_package_id: input.expected_package_id,
      organization_id: input.organization_id,
      store_id: input.store_id,
      order_id: n(ep.order_id) ?? input.order_id,
      order_type: n(ep.order_type),
      build_source: n(ep.build_source) ?? input.build_source,
      source_detail_row_id: n(ep.source_detail_row_id),
      source_shipment_row_id: n(ep.source_shipment_row_id),
      tracking_number: n(ep.tracking_number) ?? n(ep.shipment_tracking),
      disposition: n(ep.disposition),
      expected_scan_quantity:
        ep.expected_scan_quantity === null || ep.expected_scan_quantity === undefined
          ? null
          : Number(ep.expected_scan_quantity),
      sku,
      fnsku,
      asin: n(ep.asin) ?? input.asin,
      asin_from_removal_raw: asinFromRemoval,
      upc: rawHints.upc ?? input.upc,
      map_product_count_fnsku: mapFnskuCount,
      map_product_count_sku: mapSkuCount,
      ...classified,
    });
  }

  const orgId = inputQueue[0]?.organization_id ?? "";
  const storeId = inputQueue[0]?.store_id ?? "";
  const spApiOk = orgId && storeId ? await spApiConfigured(client, orgId, storeId) : false;
  await client.end();

  const counts = {
    total: queue.length,
    asin_ready: queue.filter((r) => r.api_readiness === "asin_ready").length,
    fnsku_ready: queue.filter((r) => r.api_readiness === "fnsku_ready").length,
    sku_only: queue.filter((r) => r.api_readiness === "sku_only").length,
    ambiguous: queue.filter((r) => r.api_readiness === "ambiguous").length,
    junk_identifiers: queue.filter((r) => r.api_readiness === "junk_identifiers").length,
    api_ready: queue.filter((r) => r.api_readiness === "asin_ready" || r.api_readiness === "fnsku_ready").length,
  };

  const apiCallPlan = queue
    .filter((r) => r.planned_call_type !== "none")
    .map((r) => ({
      expected_package_id: r.expected_package_id,
      call_type: r.planned_call_type,
      primary_identifier: r.planned_primary_identifier,
      order_id: r.order_id,
      fnsku: r.fnsku,
      sku: r.sku,
    }));

  const nextPrompt =
    counts.api_ready > 0
      ? "REMOVAL-MISSING-PRODUCTS-AMAZON-EVIDENCE-DRY-RUN-EXECUTE — run SP-API evidence dry-run for fnsku_ready/asin_ready rows after approval"
      : "REMOVAL-SOURCE-IDENTIFIER-REPAIR — repair junk FNSKU/ASIN field pollution before Amazon evidence";

  fs.writeFileSync(path.join(outDir, "amazon-evidence-queue.json"), JSON.stringify({ queue, counts }, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon-evidence-queue.jsonl"), queue.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "identifier-readiness.json"), JSON.stringify(queue, null, 2));
  fs.writeFileSync(path.join(outDir, "api-call-plan.json"), JSON.stringify({ calls: apiCallPlan, total_calls: apiCallPlan.length }, null, 2));

  fs.writeFileSync(
    path.join(outDir, "amazon-evidence-dry-run-plan.md"),
    [
      "# Amazon evidence dry-run plan",
      "",
      `**Queue source:** \`${RESOLVER_EXEC}/queue-missing-product-needs-evidence.jsonl\``,
      `**Evidence rows:** ${counts.total}`,
      `**API-ready (asin + fnsku):** ${counts.api_ready}`,
      `**SP-API configured on staging store:** ${spApiOk ? "yes" : "no"}`,
      "",
      "## Phase 1 — FBA inventory by X-FNSKU",
      "",
      `Rows: **${counts.fnsku_ready}**`,
      "",
      "- Endpoint: `GET /fba/inventory/v1/summaries` with `sellerSku` = X-FNSKU",
      "- Resolve ASIN + seller SKU from inventory summaries",
      "",
      "## Phase 2 — Catalog GET by ASIN",
      "",
      `Direct ASIN-ready rows: **${counts.asin_ready}**`,
      `Plus ASINs resolved from Phase 1`,
      "",
      "- Endpoint: `GET /catalog/2022-04-01/items/{asin}`",
      "",
      "## Excluded from API (do not call until repaired)",
      "",
      `- **junk_identifiers:** ${counts.junk_identifiers} — FNSKU column contains retail ASIN (B0…) or dirty UNKNOW SKU`,
      `- **sku_only:** ${counts.sku_only}`,
      `- **ambiguous:** ${counts.ambiguous}`,
      "",
      "## Hard rules",
      "",
      "- No DB writes",
      "- No products.insert",
      "- No product_identifier_map.insert",
      "- Approval: `.cursor/operator-approvals/removal-missing-products-amazon-evidence-approval.md`",
      "",
      `## Exact next prompt`,
      "",
      `**\`${nextPrompt}\`**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file pointer",
      "",
      `Created/updated: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_REMOVAL_MISSING_PRODUCTS_AMAZON_EVIDENCE=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      ...blockers.map((b) => `- ${b}`),
      blockers.length ? "" : "- Read-only plan; no DB writes.",
      !spApiOk ? "- SP-API credentials not confirmed on staging store — dry-run execute will halt until configured." : "",
      counts.junk_identifiers > 0
        ? `- ${counts.junk_identifiers} rows have junk identifiers (ASIN stuffed in fnsku column) — exclude from API batch or repair source first.`
        : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  writeApprovalFile(counts.total, counts.api_ready, runId);

  const manifest = {
    prompt: "PC03D EVIDENCE QUEUE FROM REMOVAL RESOLVER",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    read_only: true,
    evidence_queue_count: counts.total,
    asin_ready_count: counts.asin_ready,
    fnsku_ready_count: counts.fnsku_ready,
    sku_only_count: counts.sku_only,
    ambiguous_count: counts.ambiguous,
    junk_identifiers_count: counts.junk_identifiers,
    api_ready_count: counts.api_ready,
    sp_api_configured: spApiOk,
    baseline_ref: RESOLVER_EXEC,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# PC03D evidence queue from removal resolver",
      "",
      `- run_id: \`${runId}\``,
      `- evidence queue: **${counts.total}**`,
      `- ASIN-ready: **${counts.asin_ready}**`,
      `- FNSKU-ready: **${counts.fnsku_ready}**`,
      `- ambiguous: **${counts.ambiguous}**`,
      `- junk identifiers: **${counts.junk_identifiers}**`,
      `- sku only: **${counts.sku_only}**`,
      `- API-ready total: **${counts.api_ready}**`,
      "",
      `**Next prompt:** ${nextPrompt}`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
