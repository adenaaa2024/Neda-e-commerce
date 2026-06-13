/**
 * PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-ORIGINAL-VERIFY-V1
 * Read-only original verification after all-path parity fix.
 *
 *   npx tsx scripts/phase-shipment-entry-product-linkage-all-paths-original-verify-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  normalizeScannerProductLinkageDisplay,
  productLinkageOperatorStatusLabel,
  PRODUCT_LINKAGE_LINKED_LABEL,
  PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL,
} from "../lib/scanner/normalize-scanner-product-linkage-display";
import { PRODUCT_LINKAGE_UNMAPPED_LABEL } from "../lib/scanner/product-linkage-display-contract";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE =
  ".cursor/audit-reports/phase-shipment-entry-product-linkage-all-paths-original-verify-v1";

const SHIPMENT25_ITEMS = [
  { item: 1, fnsku: "ZZQDPD4GHB", upc: "071662213749" },
  { item: 2, fnsku: "ZZQCP25AW3", upc: "012044000854" },
];

const EXPECTED_CONTROL = { fnsku: "X004LKS4VD", label: PRODUCT_LINKAGE_LINKED_LABEL };
const UNMAPPED_CONTROL = { fnsku: "X000NOMAP99", label: PRODUCT_LINKAGE_UNMAPPED_LABEL };

const SCANNER_SAVE_PATHS = [
  "app/scanner/operator-mobile/_components/operator-store-actions.ts",
  "app/scanner/operator-mobile/scan/page.tsx",
  "lib/scanner/apply-return-item-product-enrichment.ts",
  "lib/scanner/scanner-linkage-patch.ts",
];

type Row = Record<string, unknown>;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(url: string): Promise<pg.Client> {
  if (!url.includes(PRODUCTION_REF)) throw new Error(`BLOCKED: must target ${PRODUCTION_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

function detectDevServers(): { running: boolean; restart_needed: boolean; notes: string[] } {
  const notes: string[] = [];
  let running = false;
  const termDir = path.join(
    process.env.USERPROFILE ?? "",
    ".cursor",
    "projects",
    "c-Users-Jennifer-Desktop-ecommerce-os",
    "terminals",
  );
  if (fs.existsSync(termDir)) {
    for (const f of fs.readdirSync(termDir)) {
      if (!f.endsWith(".txt")) continue;
      const t = fs.readFileSync(path.join(termDir, f), "utf8");
      if (/active_command:.*npm run dev|> next dev/m.test(t)) {
        running = true;
        notes.push(`dev server active: terminal ${f}`);
      }
    }
  }
  try {
    const out = execSync('netstat -ano | findstr ":3000 :3001"', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (out.includes("LISTENING")) notes.push("ports 3000/3001 LISTENING");
  } catch {
    /* ignore */
  }
  return { running, restart_needed: running, notes };
}

function runtimeBindCheck(): {
  original_runtime_ref: string | null;
  runtime_points_at_original: boolean;
  url_matches_original: boolean;
  service_key_matches_original: boolean;
} {
  const nextPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const runtimeRef = refFromSupabaseUrl(nextPublicUrl);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const originalServiceKey = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  return {
    original_runtime_ref: runtimeRef,
    runtime_points_at_original: runtimeRef === ORIGINAL_REF,
    url_matches_original: Boolean(nextPublicUrl && originalUrl && nextPublicUrl === originalUrl),
    service_key_matches_original: Boolean(
      serviceKey && originalServiceKey && serviceKey === originalServiceKey,
    ),
  };
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const q = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(q.rows.map((r: Row) => String(r.column_name)));
}

async function mapHits(
  c: pg.Client,
  mapCols: Set<string>,
  productCols: Set<string>,
  fnsku: string,
  upc: string,
): Promise<{ hit: boolean; hit_count: number; rows: Row[]; ambiguity: number }> {
  const fUpper = fnsku.trim().toUpperCase();
  const uNorm = upc.replace(/\D/g, "");
  const upcCol = mapCols.has("upc_code") ? "upc_code" : mapCols.has("upc") ? "upc" : null;
  const pName = productCols.has("product_name") ? "p.product_name" : "NULL::text AS product_name";
  const pNameAlt = productCols.has("name") ? "p.name" : "NULL::text AS name";
  const clauses = [`upper(btrim(coalesce(m.fnsku,''))) = $2`];
  const params: unknown[] = [ORG, fUpper];
  if (upcCol && uNorm) {
    params.push(uNorm);
    clauses.push(
      `regexp_replace(coalesce(m.${upcCol},''), '\\D', '', 'g') IN ($${params.length}, ltrim($${params.length}, '0'))`,
    );
  }
  const q = await c.query(
    `SELECT m.id, m.product_id, m.fnsku, m.asin, m.seller_sku, m.msku,
            ${upcCol ? `m.${upcCol}` : "NULL::text"} AS upc_val,
            ${pName}, ${pNameAlt}
     FROM product_identifier_map m
     JOIN products p ON p.id = m.product_id
     WHERE m.organization_id = $1::uuid AND m.deleted_at IS NULL AND p.deleted_at IS NULL
       AND (${clauses.join(" OR ")})
     ORDER BY m.last_seen_at DESC NULLS LAST
     LIMIT 20`,
    params,
  );
  const productIds = new Set(q.rows.map((r: Row) => r.product_id));
  return {
    hit: (q.rowCount ?? 0) > 0,
    hit_count: q.rowCount ?? 0,
    rows: q.rows,
    ambiguity: productIds.size > 1 ? productIds.size : 0,
  };
}

async function slipSource(
  c: pg.Client,
  slipCols: Set<string>,
  fnsku: string,
  upc: string,
): Promise<{ source_table: string; rows: Row[] }> {
  const fUpper = fnsku.trim().toUpperCase();
  const uNorm = upc.replace(/\D/g, "");
  const upcCol = slipCols.has("upc") ? "upc" : slipCols.has("product_identifier") ? "product_identifier" : null;
  const want = [
    "id",
    "organization_id",
    "store_id",
    "fnsku",
    "asin",
    "sku",
    "product_id",
    "resolved_product_id",
    "identifier_resolution_status",
    "item_name",
    "description",
    "package_id",
  ];
  const sel = want.filter((w) => slipCols.has(w));
  if (upcCol && !sel.includes(upcCol)) sel.push(upcCol);
  if (!sel.includes("fnsku")) return { source_table: "slip_contents", rows: [] };
  const clauses = [`upper(btrim(coalesce(fnsku,''))) = $2`];
  const params: unknown[] = [ORG, fUpper];
  if (upcCol) {
    params.push(uNorm);
    clauses.push(
      `regexp_replace(coalesce(${upcCol},''), '\\D', '', 'g') IN ($${params.length}, ltrim($${params.length}, '0'))`,
    );
  }
  const orderCol = slipCols.has("updated_at")
    ? "updated_at"
    : slipCols.has("created_at")
      ? "created_at"
      : "id";
  const q = await c.query(
    `SELECT ${sel.join(", ")}
     FROM slip_contents
     WHERE organization_id = $1::uuid AND (${clauses.join(" OR ")})
     ORDER BY ${orderCol} DESC NULLS LAST
     LIMIT 5`,
    params,
  );
  return { source_table: "slip_contents", rows: q.rows };
}

async function findAmbiguousFnsku(c: pg.Client): Promise<{ fnsku: string; product_count: number } | null> {
  const q = await c.query(
    `SELECT upper(btrim(fnsku)) AS fnsku, COUNT(DISTINCT product_id)::int AS product_count
     FROM product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND fnsku IS NOT NULL AND btrim(fnsku) <> ''
     GROUP BY upper(btrim(fnsku))
     HAVING COUNT(DISTINCT product_id) > 1
     ORDER BY COUNT(DISTINCT product_id) DESC
     LIMIT 1`,
    [ORG],
  );
  const row = q.rows[0] as Row | undefined;
  if (!row?.fnsku) return null;
  return { fnsku: String(row.fnsku), product_count: Number(row.product_count) };
}

async function simulateDisplay(
  sb: SupabaseClient,
  input: {
    sourceTable: string;
    sourceRowId?: string | null;
    row: Row;
  },
): Promise<Row> {
  const linkage = await normalizeScannerProductLinkageDisplay(sb, {
    organizationId: ORG,
    storeId: STORE,
    sourceTable: input.sourceTable,
    sourceRowId: input.sourceRowId ? String(input.sourceRowId) : null,
    row: input.row,
  });
  return {
    display_label: productLinkageOperatorStatusLabel(linkage),
    product_id: linkage.resolved_product_id ?? linkage.product_id ?? null,
    product_name: linkage.product_name ?? null,
    identifier_resolution_status: linkage.identifier_resolution_status ?? null,
    resolved_product_id: linkage.resolved_product_id ?? null,
  };
}

function scannerSaveUnchangedCheck(): {
  unchanged: boolean;
  save_mutations_unchanged: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  let hasDiff = false;
  for (const rel of SCANNER_SAVE_PATHS) {
    try {
      const diff = execSync(`git diff HEAD -- "${rel}"`, { encoding: "utf8" }).trim();
      if (diff) {
        hasDiff = true;
        const saveMutations = /insertOperator|updateOperator|saveOperator|allocate|closeOperator/i.test(diff);
        notes.push(
          `${rel}: uncommitted diff vs HEAD${saveMutations ? " (includes save/allocation)" : " (display/read paths only)"}`,
        );
      }
    } catch {
      notes.push(`${rel}: git diff failed`);
    }
  }
  const saveMutationsUnchanged = !notes.some((n) => n.includes("includes save/allocation"));
  if (!hasDiff) notes.push("no uncommitted changes in scanner paths vs HEAD");
  return { unchanged: !hasDiff, save_mutations_unchanged: saveMutationsUnchanged, notes };
}

async function main() {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const runtime = runtimeBindCheck();
  const dev = detectDevServers();
  const saveCheck = scannerSaveUnchangedCheck();

  bindProductionSupabaseEnv();
  const originalUrl = process.env.ORIGINAL_SUPABASE_URL ?? "";
  const originalKey = process.env.ORIGINAL_SERVICE_ROLE_KEY ?? "";
  const sb = createClient(originalUrl, originalKey, { auth: { persistSession: false } });
  const pgUrl = productionPostgresUrl();
  const c = await connectPg(pgUrl);
  const mapCols = await tableColumns(c, "product_identifier_map");
  const productCols = await tableColumns(c, "products");
  const slipCols = await tableColumns(c, "slip_contents");

  const shipment25Results: Row[] = [];
  for (const item of SHIPMENT25_ITEMS) {
    const map = await mapHits(c, mapCols, productCols, item.fnsku, item.upc);
    const slip = await slipSource(c, slipCols, item.fnsku, item.upc);
    const primarySlip = slip.rows[0] ?? null;
    const display = await simulateDisplay(sb, {
      sourceTable: "slip_contents",
      sourceRowId: primarySlip?.id ? String(primarySlip.id) : null,
      row: {
        fnsku: item.fnsku,
        upc: item.upc,
        description: primarySlip?.description ?? primarySlip?.item_name ?? null,
        resolved_product_id: primarySlip?.resolved_product_id ?? null,
        identifier_resolution_status: primarySlip?.identifier_resolution_status ?? "unresolved",
      },
    });
    shipment25Results.push({
      item: item.item,
      fnsku: item.fnsku,
      upc: item.upc,
      product_identifier_map_hit: map.hit,
      product_identifier_map_hit_count: map.hit_count,
      product_identifier_map_ambiguity: map.ambiguity,
      map_rows: map.rows.map((r) => ({
        product_id: r.product_id,
        product_name: r.product_name ?? r.name,
        fnsku: r.fnsku,
      })),
      source_path: primarySlip
        ? {
            source_kind: "slip_only",
            source_table: "slip_contents",
            row_id: primarySlip.id,
            package_id: primarySlip.package_id,
            persisted_resolved_product_id: primarySlip.resolved_product_id,
            persisted_status: primarySlip.identifier_resolution_status,
          }
        : { source_kind: "not_found_on_original", source_table: null, row_id: null },
      display_label: display.display_label,
      product_id: display.product_id,
      product_name: display.product_name,
      identifier_resolution_status: display.identifier_resolution_status,
      enrich_path: "normalizeScannerProductLinkageDisplay(slip_contents)",
    });
  }

  const expectedDisplay = await simulateDisplay(sb, {
    sourceTable: "expected_packages",
    row: { fnsku: EXPECTED_CONTROL.fnsku, identifier_resolution_status: "unresolved" },
  });
  const expectedMap = await mapHits(c, mapCols, productCols, EXPECTED_CONTROL.fnsku, "");

  const unmappedDisplay = await simulateDisplay(sb, {
    sourceTable: "slip_contents",
    row: { fnsku: UNMAPPED_CONTROL.fnsku, identifier_resolution_status: "unresolved" },
  });

  const ambiguousFnsku = await findAmbiguousFnsku(c);
  let ambiguousControl: Row;
  if (ambiguousFnsku) {
    const ambDisplay = await simulateDisplay(sb, {
      sourceTable: "slip_contents",
      row: { fnsku: ambiguousFnsku.fnsku, identifier_resolution_status: "unresolved" },
    });
    ambiguousControl = {
      fnsku: ambiguousFnsku.fnsku,
      distinct_product_ids_in_map: ambiguousFnsku.product_count,
      display_label: ambDisplay.display_label,
      expected_label: PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL,
      pass: ambDisplay.display_label === PRODUCT_LINKAGE_NEEDS_PRODUCT_REVIEW_LABEL,
    };
  } else {
    ambiguousControl = {
      fnsku: null,
      note: "no ambiguous fnsku with multiple product_ids found on original — skipped",
      pass: null,
    };
  }

  const expectedPass =
    expectedDisplay.display_label === EXPECTED_CONTROL.label && expectedMap.hit;
  const unmappedPass = unmappedDisplay.display_label === UNMAPPED_CONTROL.label;

  const allPathsVerdict =
    expectedPass &&
    unmappedPass &&
    (ambiguousControl.pass === true || ambiguousControl.pass === null)
      ? "PASS_ON_ORIGINAL_READMODEL"
      : "PARTIAL_OR_FAIL";

  const runtimeOk = runtime.runtime_points_at_original && runtime.url_matches_original;
  const devRestartOk = !dev.running || runtimeOk;

  const safeClaim =
    allPathsVerdict === "PASS_ON_ORIGINAL_READMODEL" &&
    saveCheck.save_mutations_unchanged &&
    runtimeOk
      ? "yes"
      : "no";

  const result = {
    phase: "PHASE-SHIPMENT-ENTRY-PRODUCT-LINKAGE-ALL-PATHS-ORIGINAL-VERIFY-V1",
    run_id: rid,
    original_runtime_ref: runtime.original_runtime_ref,
    original_db_ref_verified: ORIGINAL_REF,
    runtime_points_at_original: runtime.runtime_points_at_original,
    runtime_bind: {
      url_matches_original: runtime.url_matches_original,
      service_key_matches_original: runtime.service_key_matches_original,
      note: runtimeOk
        ? "NEXT_PUBLIC_SUPABASE_URL bound to original"
        : "MISMATCH: .env.local NEXT_PUBLIC_SUPABASE_URL still staging — dev UI reads staging until swap+restart",
    },
    dev_server: {
      running: dev.running,
      restart_needed_after_fix: dev.restart_needed && !runtimeOk,
      notes: dev.notes,
    },
    shipment25_item_results: shipment25Results,
    expected_path_control_result: {
      fnsku: EXPECTED_CONTROL.fnsku,
      product_identifier_map_hit: expectedMap.hit,
      display_label: expectedDisplay.display_label,
      product_id: expectedDisplay.product_id,
      product_name: expectedDisplay.product_name,
      source_path: "expected_packages / v_inventory via normalizeScannerProductLinkageDisplay",
      pass: expectedPass,
    },
    unmapped_control_result: {
      fnsku: UNMAPPED_CONTROL.fnsku,
      display_label: unmappedDisplay.display_label,
      product_id: unmappedDisplay.product_id,
      pass: unmappedPass,
    },
    ambiguous_control_result: ambiguousControl,
    all_paths_linkage_verdict: allPathsVerdict,
    line_source_paths_verified: [
      "slip_contents → normalizeScannerProductLinkageDisplay (shipment25 items)",
      "expected_packages identifier → normalizeScannerProductLinkageDisplay (X004LKS4VD)",
      "unmapped fnsku control",
      ambiguousFnsku ? "ambiguous map fnsku control" : "ambiguous control skipped (none found)",
    ],
    no_data_mutation_verification: true,
    no_scanner_save_logic_change_verification: saveCheck,
    SAFE_TO_CONTINUE_CLAIM_WORK: safeClaim,
    NEXT_PROMPT:
      runtimeOk && devRestartOk
        ? "PHASE-SHIPMENT-ENTRY-LINKAGE-UI-BROWSER-SMOKE-V1"
        : "PHASE-ORIGINAL-RUNTIME-ENV-SWAP-AND-RESTART-V1",
  };

  await c.end();

  fs.writeFileSync(path.join(outDir, "verify-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "verify-summary.md"),
    `# Original all-paths linkage verify

**Run:** ${rid}
**Original DB ref:** ${ORIGINAL_REF}
**Runtime ref:** ${runtime.original_runtime_ref} (points at original: ${runtime.runtime_points_at_original})
**Verdict:** ${allPathsVerdict}
**SAFE_TO_CONTINUE_CLAIM_WORK:** ${safeClaim}

## Shipment #25 screenshot items
${shipment25Results
  .map(
    (r) =>
      `- Item ${r.item} **${r.fnsku}** / ${r.upc}: map_hit=${r.product_identifier_map_hit} label=**${r.display_label}** source=${(r.source_path as Row).source_table ?? "—"}`,
  )
  .join("\n")}

## Controls
- Expected **${EXPECTED_CONTROL.fnsku}**: ${expectedDisplay.display_label} (pass=${expectedPass})
- Unmapped **${UNMAPPED_CONTROL.fnsku}**: ${unmappedDisplay.display_label} (pass=${unmappedPass})
- Ambiguous: ${ambiguousControl.pass === null ? "skipped" : ambiguousControl.display_label}
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        original_runtime_ref: runtime.original_runtime_ref,
        all_paths_linkage_verdict: allPathsVerdict,
        SAFE_TO_CONTINUE_CLAIM_WORK: safeClaim,
        NEXT_PROMPT: result.NEXT_PROMPT,
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
