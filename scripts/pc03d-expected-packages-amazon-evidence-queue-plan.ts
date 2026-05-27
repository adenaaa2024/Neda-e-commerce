/**
 * PC03D — EXPECTED PACKAGES AMAZON EVIDENCE QUEUE PLAN (read-only)
 *
 * Plans SP-API evidence dry-run for PC03C requires_amazon_evidence cohort.
 * No Amazon HTTP. No DB writes.
 *
 *   npx tsx scripts/pc03d-expected-packages-amazon-evidence-queue-plan.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03d-expected-packages-amazon-evidence-queue-plan.ts --queue-run-id=20260525T160000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const QUEUE_DEFAULT = "20260525T160000Z";
const QUEUE_BASE = ".cursor/audit-reports/pc03c-expected-packages-quarantined-manual-queue";
const OUT_BASE = ".cursor/audit-reports/pc03d-expected-packages-amazon-evidence-queue-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/pc03d-expected-packages-amazon-evidence-approval.md";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";

type QueueRow = {
  expected_package_id: string;
  cohort: string;
  sku: string | null;
  fnsku: string | null;
  order_id: string | null;
  order_type: string | null;
  disposition: string | null;
  tracking_number: string | null;
  build_source: string | null;
  identifier_resolution_status: string | null;
  recommended_action: string;
  approve_ready: boolean;
  notes: string;
};

type ReadinessRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  source_sku: string | null;
  source_fnsku: string | null;
  source_asin: string | null;
  source_upc: string | null;
  spine_asin_candidates: string[];
  spine_sku_candidates: string[];
  map_asin: string | null;
  map_seller_sku: string | null;
  map_upc: string | null;
  catalog_asin: string | null;
  readiness: "catalog_asin_ready" | "fnsku_inventory_lookup" | "ambiguous" | "blocked";
  api_ready: boolean;
  ambiguous: boolean;
  planned_primary_identifier: string | null;
  planned_call_type: "catalog_get_by_asin" | "fba_inventory_by_fnsku" | "none";
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

function queueRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--queue-run-id="));
  return a ? a.split("=")[1]!.trim() : QUEUE_DEFAULT;
}

function isDirtySku(sku: string | null): boolean {
  const s = (sku ?? "").trim().toUpperCase();
  return s === "" || s === "UNKNOW" || s === "UNKNOWN";
}

function isAsin(v: string | null): boolean {
  return !!v && /^B[0-9A-Z]{9}$/i.test(v.trim());
}

function isXFnsku(v: string | null): boolean {
  return !!v && /^X[0-9A-Z]{9,}$/i.test(v.trim());
}

function writeApprovalFile(evidenceCount: number, runId: string): void {
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_PATH),
    `# PC03D expected packages Amazon evidence dry-run

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product creation | forbidden |
| DB writes | forbidden (dry-run only) |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_PC03D_AMAZON_EVIDENCE_DRY_RUN=false
\`\`\`

## Scope

- Evidence queue rows: **${evidenceCount}**
- Plan: \`${OUT_BASE}/${runId}/\`
- Mode: SP-API catalog / inventory evidence dry-run only

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_PC03D_AMAZON_EVIDENCE_DRY_RUN=false
Approved by:
UTC date:
\`\`\`
`,
  );
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

function classifyReadiness(row: {
  source_sku: string | null;
  source_fnsku: string | null;
  source_asin: string | null;
  spine_asin_candidates: string[];
  map_asin: string | null;
}): Pick<ReadinessRow, "readiness" | "api_ready" | "ambiguous" | "catalog_asin" | "planned_primary_identifier" | "planned_call_type" | "notes"> {
  const asinSet = new Set<string>();
  if (isAsin(row.source_asin)) asinSet.add(row.source_asin!.trim().toUpperCase());
  if (isAsin(row.map_asin)) asinSet.add(row.map_asin!.trim().toUpperCase());
  for (const a of row.spine_asin_candidates) {
    if (isAsin(a)) asinSet.add(a.trim().toUpperCase());
  }

  if (asinSet.size > 1) {
    return {
      readiness: "ambiguous",
      api_ready: false,
      ambiguous: true,
      catalog_asin: null,
      planned_primary_identifier: null,
      planned_call_type: "none",
      notes: `Multiple ASIN candidates: ${[...asinSet].join(", ")}`,
    };
  }
  if (asinSet.size === 1) {
    const asin = [...asinSet][0]!;
    return {
      readiness: "catalog_asin_ready",
      api_ready: true,
      ambiguous: false,
      catalog_asin: asin,
      planned_primary_identifier: asin,
      planned_call_type: "catalog_get_by_asin",
      notes: "Single resolvable ASIN for catalog GET",
    };
  }

  if (isXFnsku(row.source_fnsku)) {
    return {
      readiness: "fnsku_inventory_lookup",
      api_ready: true,
      ambiguous: false,
      catalog_asin: null,
      planned_primary_identifier: row.source_fnsku!.trim().toUpperCase(),
      planned_call_type: "fba_inventory_by_fnsku",
      notes: "X-FNSKU only — plan FBA inventory / listings lookup before catalog GET",
    };
  }

  return {
    readiness: "blocked",
    api_ready: false,
    ambiguous: false,
    catalog_asin: null,
    planned_primary_identifier: null,
    planned_call_type: "none",
    notes: "No catalog ASIN and no X-FNSKU for inventory lookup",
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const queueRunId = queueRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const queuePath = path.join(process.cwd(), QUEUE_BASE, queueRunId, "manual-review-queue.json");
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!fs.existsSync(queuePath)) blockers.push(`Missing ${queuePath}`);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push(`DB URL must target staging ${STAGING_REF}`);
  }

  let evidenceRows: QueueRow[] = [];
  if (fs.existsSync(queuePath)) {
    const parsed = JSON.parse(fs.readFileSync(queuePath, "utf8")) as { queue: QueueRow[] };
    evidenceRows = (parsed.queue ?? []).filter((r) => r.recommended_action === "requires_amazon_evidence");
  }
  if (evidenceRows.length !== 5) {
    blockers.push(`Expected 5 requires_amazon_evidence rows, got ${evidenceRows.length}`);
  }

  let readiness: ReadinessRow[] = [];
  let spApiOk = false;

  if (!blockers.length) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '120s'");

    const epIds = evidenceRows.map((r) => r.expected_package_id);
    const enrichRes = await client.query(
      `
      WITH target AS (
        SELECT e.id, e.organization_id, e.store_id,
          NULLIF(TRIM(e.sku), '') AS sku,
          NULLIF(TRIM(e.fnsku), '') AS fnsku
        FROM public.expected_packages e
        WHERE e.id = ANY($1::uuid[])
      ),
      map_one AS (
        SELECT t.id AS ep_id,
          MAX(NULLIF(TRIM(m.asin), '')) FILTER (WHERE m.asin IS NOT NULL) AS map_asin,
          MAX(NULLIF(TRIM(m.seller_sku), '')) FILTER (WHERE m.seller_sku IS NOT NULL) AS map_seller_sku,
          COUNT(DISTINCT m.asin) FILTER (WHERE m.asin IS NOT NULL)::int AS asin_count
        FROM target t
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id = t.organization_id AND m.store_id = t.store_id
         AND m.deleted_at IS NULL AND t.fnsku IS NOT NULL AND m.fnsku = t.fnsku
        GROUP BY t.id
      ),
      inv AS (
        SELECT t.id AS ep_id, x.asin, x.sku
        FROM target t
        CROSS JOIN LATERAL (
          SELECT NULLIF(TRIM(f.asin), '') AS asin, NULLIF(TRIM(f.sku), '') AS sku
          FROM public.amazon_fba_inventory f
          WHERE f.organization_id = t.organization_id AND f.store_id = t.store_id
            AND t.fnsku IS NOT NULL AND f.fnsku = t.fnsku
          UNION ALL
          SELECT NULLIF(TRIM(mf.asin), ''), NULLIF(TRIM(mf.sku), '')
          FROM public.amazon_manage_fba_inventory mf
          WHERE mf.organization_id = t.organization_id AND mf.store_id = t.store_id
            AND t.fnsku IS NOT NULL AND mf.fnsku = t.fnsku
        ) x
        WHERE x.asin IS NOT NULL OR x.sku IS NOT NULL
      ),
      inv_agg AS (
        SELECT ep_id,
          array_agg(DISTINCT asin) FILTER (WHERE asin IS NOT NULL) AS spine_asins,
          array_agg(DISTINCT sku) FILTER (WHERE sku IS NOT NULL) AS spine_skus
        FROM inv
        GROUP BY ep_id
      )
      SELECT t.id::text AS expected_package_id,
        t.organization_id::text, t.store_id::text,
        t.sku AS source_sku, t.fnsku AS source_fnsku,
        NULL::text AS source_asin, NULL::text AS source_upc,
        COALESCE(ia.spine_asins, ARRAY[]::text[]) AS spine_asin_candidates,
        COALESCE(ia.spine_skus, ARRAY[]::text[]) AS spine_sku_candidates,
        mo.map_asin, mo.map_seller_sku, mo.asin_count
      FROM target t
      LEFT JOIN inv_agg ia ON ia.ep_id = t.id
      LEFT JOIN map_one mo ON mo.ep_id = t.id
      ORDER BY t.fnsku, t.id
      `,
      [epIds],
    );

    const sampleOrg = (enrichRes.rows[0] as { organization_id?: string } | undefined)?.organization_id;
    const sampleStore = (enrichRes.rows[0] as { store_id?: string } | undefined)?.store_id;
    if (sampleOrg && sampleStore) {
      spApiOk = await spApiConfigured(client, sampleOrg, sampleStore);
    }

    for (const r of enrichRes.rows as Record<string, unknown>[]) {
      const spineAsins = Array.isArray(r.spine_asin_candidates)
        ? (r.spine_asin_candidates as string[]).filter(Boolean)
        : [];
      const spineSkus = Array.isArray(r.spine_sku_candidates)
        ? (r.spine_sku_candidates as string[]).filter(Boolean)
        : [];
      const mapAsinCount = Number(r.asin_count ?? 0);
      const base = {
        source_sku: r.source_sku ? String(r.source_sku) : null,
        source_fnsku: r.source_fnsku ? String(r.source_fnsku) : null,
        source_asin: null as string | null,
        spine_asin_candidates: spineAsins,
        map_asin: mapAsinCount === 1 && r.map_asin ? String(r.map_asin) : null,
      };
      let cls = classifyReadiness(base);
      if (mapAsinCount > 1) {
        cls = {
          readiness: "ambiguous",
          api_ready: false,
          ambiguous: true,
          catalog_asin: null,
          planned_primary_identifier: null,
          planned_call_type: "none",
          notes: `Map has ${mapAsinCount} distinct ASINs for FNSKU`,
        };
      }
      readiness.push({
        expected_package_id: String(r.expected_package_id),
        organization_id: String(r.organization_id),
        store_id: String(r.store_id),
        source_sku: base.source_sku,
        source_fnsku: base.source_fnsku,
        source_asin: base.source_asin,
        source_upc: null,
        spine_asin_candidates: spineAsins,
        spine_sku_candidates: spineSkus,
        map_asin: r.map_asin ? String(r.map_asin) : null,
        map_seller_sku: r.map_seller_sku ? String(r.map_seller_sku) : null,
        map_upc: null,
        ...cls,
      });
    }

    await client.end();
  }

  const apiReadyCount = readiness.filter((r) => r.api_ready).length;
  const ambiguousCount = readiness.filter((r) => r.ambiguous).length;
  const catalogJobs = readiness.filter((r) => r.planned_call_type === "catalog_get_by_asin");
  const fnskuJobs = readiness.filter((r) => r.planned_call_type === "fba_inventory_by_fnsku");

  writeApprovalFile(evidenceRows.length, runId);

  fs.writeFileSync(path.join(outDir, "identifier-readiness.json"), JSON.stringify(readiness, null, 2));

  fs.writeFileSync(
    path.join(outDir, "amazon-evidence-queue.md"),
    [
      "# Amazon evidence queue — PC03D",
      "",
      `**Run id:** \`${runId}\` | **Queue ref:** \`${QUEUE_BASE}/${queueRunId}\``,
      `**Branch:** \`${branch}\` | **Staging:** \`${STAGING_REF}\``,
      "",
      "## Summary",
      "",
      `- **Evidence rows:** ${evidenceRows.length}`,
      `- **API-ready:** ${apiReadyCount}`,
      `- **Ambiguous:** ${ambiguousCount}`,
      `- **Catalog GET jobs:** ${catalogJobs.length}`,
      `- **FNSKU inventory lookup jobs:** ${fnskuJobs.length}`,
      `- **SP-API credentials configured:** ${spApiOk ? "yes" : "no (blocker for execute)"}`,
      "",
      "## Cohort",
      "",
      "All rows are `quarantined_dirty_source` with `UNKNOW` sku and X-FNSKU only (no inventory proof in PC03C queue).",
      "",
      "| ep_id | fnsku | sku | order_id | readiness | api_ready | planned_call |",
      "|-------|-------|-----|----------|-----------|:---------:|--------------|",
      ...readiness.map(
        (r) =>
          `| \`${r.expected_package_id.slice(0, 8)}…\` | ${r.source_fnsku ?? "—"} | ${isDirtySku(r.source_sku) ? "UNKNOW" : r.source_sku ?? "—"} | ${evidenceRows.find((e) => e.expected_package_id === r.expected_package_id)?.order_id ?? "—"} | ${r.readiness} | ${r.api_ready ? "yes" : "no"} | ${r.planned_call_type} |`,
      ),
      "",
      "## Identifier sources per row",
      "",
      ...readiness.map((r) => {
        const lines = [
          `### \`${r.expected_package_id}\``,
          "",
          `- **FNSKU:** ${r.source_fnsku ?? "—"}`,
          `- **SKU:** ${r.source_sku ?? "—"} (dirty)`,
          `- **ASIN (source):** ${r.source_asin ?? "—"}`,
          `- **UPC:** ${r.source_upc ?? r.map_upc ?? "—"}`,
          `- **Map ASIN:** ${r.map_asin ?? "—"}`,
          `- **Spine ASINs:** ${r.spine_asin_candidates.length ? r.spine_asin_candidates.join(", ") : "—"}`,
          `- **Spine SKUs:** ${r.spine_sku_candidates.length ? r.spine_sku_candidates.join(", ") : "—"}`,
          `- **Notes:** ${r.notes}`,
          "",
        ];
        return lines.join("\n");
      }),
    ].join("\n") + "\n",
  );

  const apiPlanLines = [
    "# API call plan — PC03D dry-run",
    "",
    "**Mode:** plan only. No HTTP in this step.",
    "",
    "**Governed execute script (future):** `scripts/pc03d-expected-packages-amazon-evidence-dry-run-execute.ts`",
    "",
    `**Approval:** \`${APPROVAL_PATH}\``,
    "",
    "## Phase 1 — FNSKU inventory / listings lookup",
    "",
    "| # | FNSKU | endpoint (planned) | marketplace | expected_package_id |",
    "|---|-------|-------------------|-------------|---------------------|",
    ...fnskuJobs.map(
      (r, i) =>
        `| ${i + 1} | \`${r.planned_primary_identifier}\` | \`GET /fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${DEFAULT_MARKETPLACE_ID}&sellerSkus=\` *(or Seller Central FNSKU→ASIN)* | ${DEFAULT_MARKETPLACE_ID} | \`${r.expected_package_id}\` |`,
    ),
    "",
    `**Phase 1 calls:** ${fnskuJobs.length}`,
    "",
    "## Phase 2 — Catalog GET (after ASIN resolved)",
    "",
    "| # | ASIN | endpoint | marketplace | expected_package_id |",
    "|---|------|----------|-------------|---------------------|",
    ...catalogJobs.map(
      (r, i) =>
        `| ${i + 1} | \`${r.planned_primary_identifier}\` | \`GET /catalog/2022-04-01/items/{asin}?includedData=summaries,attributes,images\` | ${DEFAULT_MARKETPLACE_ID} | \`${r.expected_package_id}\` |`,
    ),
    ...(catalogJobs.length === 0
      ? ["", "*No catalog GET until Phase 1 resolves ASIN for each FNSKU.*", ""]
      : []),
    "",
    `**Phase 2 calls (if ASINs resolved):** ${catalogJobs.length}`,
    "",
    "**Total planned calls (max):** " + `${fnskuJobs.length + catalogJobs.length}`,
    "",
    "**Forbidden:** products.insert, product_identifier_map.insert, expected_packages UPDATE, Amazon calls in plan step.",
  ];
  fs.writeFileSync(path.join(outDir, "api-call-plan.md"), apiPlanLines.join("\n") + "\n");

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Created/updated: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_PC03D_AMAZON_EVIDENCE_DRY_RUN=false",
      "```",
      "",
      "Both flags must be `true` before PC03D dry-run execute.",
    ].join("\n") + "\n",
  );

  const planBlockers = [...blockers];
  if (!spApiOk && !blockers.length) {
    planBlockers.push("SP-API credentials not configured on staging store (execute will block until fixed)");
  }

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    planBlockers.length
      ? planBlockers.map((b) => `- ${b}`).join("\n") + "\n"
      : "- Read-only plan complete; no DB writes; no Amazon HTTP.\n",
  );

  const nextPrompt =
    "PC03D-EXEC — EXPECTED-PACKAGES-AMAZON-EVIDENCE-DRY-RUN-EXECUTE (after APPROVED_PC03D_AMAZON_EVIDENCE_DRY_RUN=true)";

  const manifest = {
    prompt: "PC03D — EXPECTED PACKAGES AMAZON EVIDENCE QUEUE PLAN",
    run_id: runId,
    queue_run_id: queueRunId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    evidence_rows_count: evidenceRows.length,
    api_ready_count: apiReadyCount,
    ambiguous_count: ambiguousCount,
    catalog_get_jobs: catalogJobs.length,
    fnsku_lookup_jobs: fnskuJobs.length,
    sp_api_configured: spApiOk,
    approval_file: APPROVAL_PATH,
    exact_next_prompt: nextPrompt,
    forbidden: {
      amazon_api_called: false,
      db_writes: false,
      product_create: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir,
        evidence_rows_count: evidenceRows.length,
        api_ready_count: apiReadyCount,
        ambiguous_count: ambiguousCount,
        approval_file: APPROVAL_PATH,
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
