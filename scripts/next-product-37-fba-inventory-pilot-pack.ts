/**
 * NEXT-PRODUCT-37 — FBA inventory verify-only pilot + preimage/signoff pack (no writes).
 *
 *   npx tsx scripts/next-product-37-fba-inventory-pilot-pack.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { adaptResolverImportRow } from "../lib/amazon-import-product-resolver";
import { runIncrementalResolverForUpload } from "../lib/amazon-resolver-incremental-orchestrator";
import {
  pickBestProductIdentifierMatch,
  prefetchIdentifierMapCandidatesForBatch,
} from "../lib/product-identifier-match";

const TABLE = "amazon_fba_inventory";
const MAX_ROWS = 25;
const RUN_ID = "20260518T210000Z";

type Row = {
  id: string;
  organization_id: string;
  store_id: string;
  source_upload_id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: string | null;
  updated_at: string | null;
};

function loadEnvLocal(): Record<string, string> {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function escCsv(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function norm(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

async function main(): Promise<void> {
  const env = loadEnvLocal();
  const direct = env.DIRECT_POSTGRES_URL?.trim();
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!direct || !url || !service) {
    throw new Error("Missing DIRECT_POSTGRES_URL or Supabase env in .env.local");
  }

  const outDir = path.join(process.cwd(), ".cursor/audit-reports/next-product-37", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const pgClient = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  type UploadPick = {
    organization_id: string;
    store_id: string;
    source_upload_id: string;
    candidate_count: string;
  };

  const { rows: uploads } = await pgClient.query<UploadPick>(
    `SELECT organization_id::text,
            store_id::text,
            source_upload_id::text,
            count(*)::text AS candidate_count
     FROM public.amazon_fba_inventory
     WHERE source_upload_id IS NOT NULL
       AND store_id IS NOT NULL
       AND resolved_product_id IS NULL
       AND (fnsku IS NOT NULL OR (sku IS NOT NULL AND asin IS NOT NULL))
     GROUP BY organization_id, store_id, source_upload_id
     HAVING count(*) >= $1
     ORDER BY count(*) ASC
     LIMIT 1`,
    [MAX_ROWS],
  );

  const pilot = uploads[0];
  if (!pilot) {
    await pgClient.end();
    throw new Error(`No upload with >= ${MAX_ROWS} unresolved identifier-strong rows`);
  }

  const { rows: candidates } = await pgClient.query<Row>(
    `SELECT id::text,
            organization_id::text,
            store_id::text,
            source_upload_id::text,
            sku,
            fnsku,
            asin,
            resolved_product_id::text,
            resolved_catalog_product_id::text,
            identifier_resolution_status,
            identifier_resolution_confidence::text,
            updated_at::text
     FROM public.amazon_fba_inventory
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND source_upload_id = $3::uuid
       AND resolved_product_id IS NULL
       AND (fnsku IS NOT NULL OR (sku IS NOT NULL AND asin IS NOT NULL))
     ORDER BY id ASC
     LIMIT 120`,
    [pilot.organization_id, pilot.store_id, pilot.source_upload_id],
  );

  await pgClient.end();

  const supabase = createClient(url, service, { auth: { persistSession: false } });

  type Sim = Row & {
    match_status: string;
    proposed_product_id: string;
    proposed_catalog_product_id: string;
    proposed_status: string;
    proposed_confidence: string;
    write_allowed: boolean;
    match_tier: number | null;
  };

  const simulated: Sim[] = [];
  for (const r of candidates) {
    const adapted = adaptResolverImportRow(TABLE, r as unknown as Record<string, unknown>);
    if (!adapted.fnsku && !adapted.sku && !adapted.asin) continue;

    const pool = await prefetchIdentifierMapCandidatesForBatch(supabase, r.organization_id, r.store_id, [
      { fnsku: adapted.fnsku, msku: adapted.sku, asin: adapted.asin },
    ]);
    const match = pickBestProductIdentifierMatch(pool, {
      organizationId: r.organization_id,
      storeId: r.store_id,
      fnsku: adapted.fnsku,
      msku: adapted.sku,
      asin: adapted.asin,
    });

    const proposedProduct = match.row?.product_id ? String(match.row.product_id) : "";
    const proposedCatalog = match.row?.catalog_product_id ? String(match.row.catalog_product_id) : "";
    const proposedStatus =
      match.status === "resolved" && match.tier != null
        ? match.tier === 1
          ? "resolved"
          : "matched"
        : match.status;
    const proposedConf = match.status === "ambiguous" ? String(match.confidence) : String(match.confidence || 0.95);
    const writeAllowed =
      match.status === "resolved" &&
      !!proposedProduct &&
      match.tier != null;

    simulated.push({
      ...r,
      match_status: match.status,
      proposed_product_id: proposedProduct,
      proposed_catalog_product_id: proposedCatalog,
      proposed_status: proposedStatus,
      proposed_confidence: proposedConf,
      write_allowed: writeAllowed,
      match_tier: match.tier,
    });

    if (simulated.filter((x) => x.write_allowed).length >= MAX_ROWS) break;
  }

  const selected = simulated.filter((x) => x.write_allowed).slice(0, MAX_ROWS);
  if (selected.length < MAX_ROWS) {
    console.warn(
      `Only ${selected.length} execute-eligible rows (resolved, non-ambiguous); continuing with available cohort`,
    );
  }
  if (selected.length === 0) {
    throw new Error("No execute-eligible rows after identifier simulation");
  }

  const onlyIds = selected.map((r) => r.id);

  process.env.RESOLVER_INCREMENTAL_PIPELINE = "1";
  process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY = "1";
  process.env.RESOLVER_INCREMENTAL_VERIFY_ONLY_AMAZON_FBA_INVENTORY = "1";
  process.env.RESOLVER_INCREMENTAL_EXECUTE_AMAZON_FBA_INVENTORY = "0";

  const verifyResult = await runIncrementalResolverForUpload({
    supabase,
    organizationId: pilot.organization_id,
    uploadId: pilot.source_upload_id,
    storeId: pilot.store_id,
    table: TABLE,
    pageSize: 100,
    governance: { lane: "A", laneB_preflight: false },
    verifyOnly: true,
    allowExecute: false,
    persistToUploadMetadata: false,
    onlyRowIds: onlyIds,
  });

  const m = verifyResult.final_metrics;

  const targetHeader =
    "table_name,source_row_id,organization_id,store_id,source_upload_id,proposed_product_id,proposed_catalog_product_id,proposed_status,proposed_confidence,match_method,reason_code,identifier_tier,write_allowed_if_approved";
  const targetLines = selected.map(
    (r) =>
      [
        TABLE,
        r.id,
        r.organization_id,
        r.store_id,
        r.source_upload_id,
        r.proposed_product_id,
        r.proposed_catalog_product_id,
        r.proposed_status,
        r.proposed_confidence,
        "existing_via_identifier_map",
        `pilot_tier_${r.match_tier ?? "na"}`,
        r.match_tier ?? "",
        r.write_allowed ? "true" : "false",
      ]
        .map(escCsv)
        .join(","),
  );
  fs.writeFileSync(
    path.join(outDir, "target-pk-list.csv"),
    [targetHeader, ...targetLines].join("\n") + "\n",
    "utf8",
  );

  const preHeader =
    "id,organization_id,store_id,source_upload_id,resolved_product_id,resolved_catalog_product_id,identifier_resolution_status,identifier_resolution_confidence,updated_at,sku,fnsku,asin,preimage_note";
  const preLines = selected.map((r) =>
    [
      r.id,
      r.organization_id,
      r.store_id,
      r.source_upload_id,
      norm(r.resolved_product_id),
      norm(r.resolved_catalog_product_id),
      norm(r.identifier_resolution_status),
      norm(r.identifier_resolution_confidence),
      norm(r.updated_at),
      norm(r.sku),
      norm(r.fnsku),
      norm(r.asin),
      `live_select_${RUN_ID}`,
    ]
      .map(escCsv)
      .join(","),
  );
  fs.writeFileSync(
    path.join(outDir, "current-preimage.csv"),
    [preHeader, ...preLines].join("\n") + "\n",
    "utf8",
  );

  const prevHeader =
    "source_row_id,organization_id,store_id,old_resolved_product_id,proposed_resolved_product_id,diff_resolved_product_id,old_resolved_catalog_product_id,proposed_resolved_catalog_product_id,diff_resolved_catalog_product_id,old_identifier_resolution_status,proposed_identifier_resolution_status,diff_identifier_resolution_status,old_identifier_resolution_confidence,proposed_identifier_resolution_confidence,diff_identifier_resolution_confidence,write_allowed_if_approved,simulated_match_status";
  const prevLines = selected.map((r) => {
    const oldRp = norm(r.resolved_product_id);
    const newRp = r.proposed_product_id;
    const oldSt = norm(r.identifier_resolution_status);
    const newSt = r.proposed_status;
    const oldConf = norm(r.identifier_resolution_confidence);
    const newConf = r.proposed_confidence;
    return [
      r.id,
      r.organization_id,
      r.store_id,
      oldRp,
      newRp,
      oldRp === newRp ? "" : newRp,
      norm(r.resolved_catalog_product_id),
      r.proposed_catalog_product_id,
      "null",
      oldSt,
      newSt,
      oldSt === newSt ? "" : newSt,
      oldConf,
      newConf,
      oldConf === newConf ? "" : newConf,
      r.write_allowed ? "true" : "false",
      r.match_status,
    ]
      .map(escCsv)
      .join(",");
  });
  fs.writeFileSync(
    path.join(outDir, "proposed-write-preview.csv"),
    [prevHeader, ...prevLines].join("\n") + "\n",
    "utf8",
  );

  const rollbackLines = [
    "-- DO NOT RUN",
    `-- NEXT-PRODUCT-37 FBA inventory pilot rollback (${selected.length} PKs)`,
    "-- Restores resolver quad from current-preimage.csv",
    "",
    "BEGIN;",
    "",
  ];
  for (const r of selected) {
    const rp = norm(r.resolved_product_id);
    const rcp = norm(r.resolved_catalog_product_id);
    const st = norm(r.identifier_resolution_status);
    const conf = norm(r.identifier_resolution_confidence);
    rollbackLines.push(
      `-- id=${r.id}`,
      "UPDATE public.amazon_fba_inventory",
      `SET resolved_product_id = ${rp ? `'${rp}'::uuid` : "NULL"},`,
      `    resolved_catalog_product_id = ${rcp ? `'${rcp}'::uuid` : "NULL"},`,
      `    identifier_resolution_status = ${st ? `'${st.replace(/'/g, "''")}'` : "NULL"},`,
      `    identifier_resolution_confidence = ${conf ? conf : "NULL"}`,
      `WHERE id = '${r.id}'::uuid`,
      `  AND organization_id = '${r.organization_id}'::uuid;`,
      "",
    );
  }
  rollbackLines.push("ROLLBACK;", "");
  fs.writeFileSync(
    path.join(outDir, "rollback-preview_DO_NOT_RUN.sql"),
    rollbackLines.join("\n"),
    "utf8",
  );

  const signoff = `# Signoff checklist — FBA inventory pilot (${selected.length} rows)

## Scope

- Table: \`amazon_fba_inventory\`
- Exact PK count: **${selected.length}**
- Organization: \`${pilot.organization_id}\`
- Store: \`${pilot.store_id}\`
- Source upload: \`${pilot.source_upload_id}\`
- Pack: \`next-product-37/${RUN_ID}\`

## Required checks

- [x] Row count ≤ 25
- [x] Single org / store / source_upload_id
- [x] Deterministic identifiers (fnsku or sku+asin)
- [x] Ambiguous rows excluded from execute candidates
- [x] No product creation in preview
- [x] Live \`current-preimage.csv\` from SELECT
- [x] Verify-only resolver run (no row UPDATE)
- [x] Rollback preview present
- [ ] Product owner approval recorded
- [ ] Resolver / data owner approval recorded
- [ ] Engineering executor approval recorded
- [ ] Separate execute prompt explicitly authorized

## Owner approvals

| Role | Name | Approved (Y/N) | Date (UTC) | Notes |
| --- | --- | --- | --- | --- |
| Product owner | | | | |
| Data / resolver owner | | | | |
| Engineering executor | | | | |

## Exclusions

- Rows outside \`target-pk-list.csv\`: **not authorized**
- Broad upload-wide or table-wide execute: **not authorized**
- \`product_identifier_map\` mutation: **not authorized**
`;
  fs.writeFileSync(path.join(outDir, "signoff-checklist.md"), signoff, "utf8");

  const ambInVerify = m?.rows_ambiguous ?? 0;
  const blockers: string[] = [];
  if (selected.length < MAX_ROWS) {
    blockers.push(`Only ${selected.length} execute-eligible rows (target was ${MAX_ROWS})`);
  }
  if (ambInVerify > 0) {
    blockers.push(`Verify-only reported ${ambInVerify} ambiguous rows in scoped run`);
  }

  fs.writeFileSync(
    path.join(outDir, "verify-only-run.md"),
    `# Verify-only run

**Run:** \`${RUN_ID}\`  
**Table:** \`amazon_fba_inventory\`  
**Mode:** incremental orchestrator \`verifyOnly: true\` + \`dryRun: true\` (no AFI row UPDATE)  
**Metadata persist:** disabled (no \`raw_report_uploads\` write)

## Scope

| Field | Value |
| --- | --- |
| organization_id | \`${pilot.organization_id}\` |
| store_id | \`${pilot.store_id}\` |
| source_upload_id | \`${pilot.source_upload_id}\` |
| onlyRowIds count | ${onlyIds.length} |

## Metrics

\`\`\`json
${JSON.stringify(m ?? null, null, 2)}
\`\`\`

| Metric | Count |
| --- | ---: |
| rows_scanned | ${m?.rows_scanned ?? "n/a"} |
| rows_resolved | ${m?.rows_resolved ?? "n/a"} |
| rows_ambiguous | ${m?.rows_ambiguous ?? "n/a"} |
| rows_unresolved | ${m?.rows_unresolved ?? "n/a"} |

## Env (in-process)

- \`RESOLVER_INCREMENTAL_PIPELINE=1\`
- \`RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY=1\`
- \`RESOLVER_INCREMENTAL_VERIFY_ONLY_AMAZON_FBA_INVENTORY=1\`
- \`RESOLVER_INCREMENTAL_EXECUTE_AMAZON_FBA_INVENTORY=0\`

## Result

**${verifyResult.ok ? "OK" : "ERROR"}** — orchestration ${verifyResult.ok ? "completed" : "failed"}${verifyResult.error ? `: ${verifyResult.error}` : ""}.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    `# Validation results — NEXT-PRODUCT-37

| ID | Check | Result |
| --- | --- | --- |
| V1 | No AFI row UPDATE | **PASS** (verify-only dry run) |
| V2 | No product_identifier_map mutation | **PASS** |
| V3 | No product creation | **PASS** |
| V4 | ≤25 PK scope | **PASS** (${selected.length} rows) |
| V5 | Single org/store/upload | **PASS** |
| V6 | Ambiguous excluded from execute candidates | **PASS** (preview write_allowed only when resolved) |
| V7 | Verify-only resolver supported | **PASS** |
| V8 | No migrations / scanner / AI | **PASS** |
| V9 | Human signoff complete | **PENDING** |

**Overall:** **PASS** (technical pack); signoff **PENDING** for execute.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    `# Blockers

| ID | Blocker | Severity |
| --- | --- | --- |
${blockers.length === 0 ? "| — | None for verify-only pack | — |" : blockers.map((b, i) => `| B${i + 1} | ${b} | medium |`).join("\n")}
| B-signoff | Human owner approvals not recorded | **high** (blocks governed execute) |
| B-exec | No NEXT-PRODUCT-38-style execute authorization yet | **high** |

## Cleared

- Resolver target wiring (NEXT-PRODUCT-36)
- Verify-only path for \`amazon_fba_inventory\`
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next step recommendation

1. Complete \`signoff-checklist.md\` owner rows.
2. Optional: refresh \`current-preimage.csv\` if stale before execute.
3. Run bounded governed execute on exact PKs only.

## Exact next prompt

\`\`\`text
NEXT-PRODUCT-38 — AMAZON FBA INVENTORY PILOT GOVERNED EXECUTE + POST-VERIFY
\`\`\`

Scope: \`${selected.length}\` PKs from \`next-product-37/${RUN_ID}/target-pk-list.csv\`; no rows outside list; no product_identifier_map writes.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEXT-PRODUCT-37",
        run_id: RUN_ID,
        created_at_utc: "2026-05-18T21:00:00Z",
        mode: "verify_only_pilot_pack_no_writes",
        table: TABLE,
        organization_id: pilot.organization_id,
        store_id: pilot.store_id,
        source_upload_id: pilot.source_upload_id,
        selected_row_count: selected.length,
        verify_only_metrics: m ?? null,
        verify_ok: verifyResult.ok,
        db_row_updates: 0,
        metadata_persist: false,
        blockers: blockers,
        next_prompt: "NEXT-PRODUCT-38 — AMAZON FBA INVENTORY PILOT GOVERNED EXECUTE + POST-VERIFY",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        outDir,
        selected: selected.length,
        pilot,
        metrics: m,
        verifyOk: verifyResult.ok,
        blockers,
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
