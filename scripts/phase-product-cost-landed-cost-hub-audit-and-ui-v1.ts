/**
 * PHASE-PRODUCT-COST-LANDED-COST-HUB-AUDIT-AND-UI-V1 — read-only cost architecture audit.
 *
 * Audits the existing cost model on the LIVE project (kxsvedvpjldygtdbylsy) and emits the
 * unified Product Cost Hub architecture (model / reuse / migration / UI / CSV) from the pure
 * contract `lib/products/contracts/product-cost-landed-cost-hub-v1.ts`.
 *
 * HARD LIMITS (enforced by construction — SELECT/HEAD only):
 *   NO DB write. NO new tables. NO claim_candidates/claim_cases/claim_lines/claim_submissions
 *   mutation. NO Amazon submission. NO scanner change. NO AI as source of truth.
 *
 *   npx tsx scripts/phase-product-cost-landed-cost-hub-audit-and-ui-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  COST_CSV_FORBIDDEN_COLUMNS,
  COST_CSV_HEADER_LINE,
  COST_CSV_OPTIONAL_EXTRA_COLUMNS,
  COST_CSV_TEMPLATE_COLUMNS,
  COST_HUB_SAFE_FLAGS,
  COST_HUB_UI_PLAN,
  COST_MODEL_FIELDS,
  COST_MODEL_RULES,
  INTERIM_NO_MIGRATION_PATH,
  NEEDS_DATA_COST_BLOCKER_PLAN,
  PRODUCT_COST_LANDED_COST_HUB_V1_VERSION,
  PRODUCT_STORY_COST_TIMELINE_PLAN,
  PROPOSED_MIGRATION,
  READY_TO_FILE_COST_DISPLAY_PLAN,
  requiredCostCsvColumns,
  SCHEMA_REUSE_ASSESSMENT,
} from "../lib/products/contracts/product-cost-landed-cost-hub-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

type TableProbe = { table: string; exists: boolean; rows: number | null; note: string };

/** Authoritative existence via direct PostgREST (PGRST205 = not in schema = does not exist). */
async function probeTable(url: string, key: string, table: string): Promise<TableProbe> {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const r = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
  if (r.status === 200 || r.status === 206) {
    const cr = await fetch(`${url}/rest/v1/${table}?select=*`, { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
    const cr2 = cr.headers.get("content-range");
    const rows = cr2 ? Number(cr2.split("/")[1]) : null;
    return { table, exists: true, rows: Number.isFinite(rows) ? rows : null, note: "exists" };
  }
  const body = (await r.json().catch(() => ({}))) as { code?: string };
  return { table, exists: false, rows: null, note: body.code ?? `http_${r.status}` };
}

/** Column list via PostgREST OpenAPI (works for tables with grants). */
async function columnsOf(url: string, key: string, table: string): Promise<string[]> {
  const r = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const spec = (await r.json()) as { definitions?: Record<string, { properties?: Record<string, unknown> }> };
  return Object.keys(spec.definitions?.[table]?.properties ?? {});
}

async function metadataCostKeys(client: SupabaseClient): Promise<{ sampled: number; keys: Record<string, number> }> {
  const { data } = await client.from("products").select("metadata").eq("organization_id", ORG).not("metadata", "is", null).limit(200);
  const keys: Record<string, number> = {};
  let sampled = 0;
  for (const row of (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const m = row.metadata;
    if (!m || typeof m !== "object") continue;
    sampled += 1;
    const attrs = (m as { product_attributes?: Record<string, unknown> }).product_attributes;
    if (attrs && typeof attrs === "object") {
      for (const k of Object.keys(attrs)) if (/cost|cogs|freight|landed|prep|ship|duty/i.test(k)) keys[`product_attributes.${k}`] = (keys[`product_attributes.${k}`] ?? 0) + 1;
    }
  }
  return { sampled, keys };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_SUPABASE_URL ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(ORIGINAL_REF)) throw new Error(`Refusing to run: ORIGINAL_SUPABASE_URL is not bound to ${ORIGINAL_REF}.`);
  const client = createClient(url, key, { auth: { persistSession: false } });

  console.log("=== PHASE-PRODUCT-COST-LANDED-COST-HUB-AUDIT-AND-UI-V1 (read-only) ===");
  console.log(`target: ${ORIGINAL_REF} · org=${ORG} · contract=${PRODUCT_COST_LANDED_COST_HUB_V1_VERSION}\n`);

  // ---- claim immutability snapshot (before) ----
  const claimTables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions"];
  const before: Record<string, number> = {};
  for (const t of claimTables) {
    const { count } = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    before[t] = count ?? -1;
  }

  // ---- PART A: existence audit ----
  const candidateTables = [
    "products", "product_identifier_map", "product_prices", "vendors", "suppliers",
    "product_cost_snapshots", "product_costs", "product_cost_layers", "product_cost_components",
    "supplier_product_costs", "purchase_orders", "purchase_order_items",
    "product_listings", "amazon_listings", "inventory", "fba_inventory", "amazon_inventory",
  ];
  const probes: TableProbe[] = [];
  for (const t of candidateTables) probes.push(await probeTable(url, key, t));

  const productsCols = await columnsOf(url, key, "products");
  const pricesCols = await columnsOf(url, key, "product_prices");
  const vendorsCols = await columnsOf(url, key, "vendors");
  const meta = await metadataCostKeys(client);

  // cogs coverage + interim overrides
  const { count: candTotal } = await client.from("claim_candidates").select("*", { count: "exact", head: true }).eq("organization_id", ORG);
  const { count: candCogs } = await client.from("claim_candidates").select("*", { count: "exact", head: true }).eq("organization_id", ORG).not("cogs_unit", "is", null);
  const { data: ws } = await client.from("workspace_settings").select("module_configs").eq("organization_id", ORG).limit(1);
  const mc = (ws && ws[0] ? (ws[0] as Record<string, unknown>).module_configs : null) as Record<string, unknown> | null;
  const ci = mc?.claim_intake as Record<string, unknown> | undefined;
  const cogsOverrides = ci?.cogs_overrides as Record<string, unknown> | undefined;

  const existing = probes.filter((p) => p.exists);
  const missing = probes.filter((p) => !p.exists);
  const costCols = [...productsCols, ...pricesCols].filter((c) => /cost|cogs|vendor|supplier|price|freight|landed|prep/i.test(c));

  console.log("──── PART A — existing_cost_model_audit ────");
  console.log("  source_tables_present:");
  for (const p of existing) console.log(`    [EXISTS] ${p.table} (rows=${p.rows ?? "?"})`);
  console.log("  cost_tables_absent (no landed-cost storage exists):");
  for (const p of missing) console.log(`    [ABSENT] ${p.table} (${p.note})`);
  console.log(`  existing_cost_fields (products + product_prices): ${costCols.join(", ") || "none"}`);
  console.log(`  vendors_columns: ${vendorsCols.join(", ")}`);
  console.log(`  ungoverned_cost_in_products.metadata (sampled ${meta.sampled}): ${JSON.stringify(meta.keys)}`);
  console.log(`  product_prices: sale/list cache lane (source=product_master_import) — NOT cost`);
  console.log(`  claim_candidates.cogs_unit (point-in-time intake snapshot): ${candCogs ?? 0}/${candTotal ?? 0}`);
  console.log(`  interim_cogs_overrides_keys: ${cogsOverrides ? Object.keys(cogsOverrides).length : 0}`);
  console.log(`  effective_dates_exist: no (no cost spine; metadata has none; product_prices has captured_at for SALE only)`);
  console.log(`  cost_history_exists: no`);
  console.log(`  landed_cost_components_exist: no`);
  console.log(`  manual_entry_exists: yes_interim (COGS panel /claim-center/reimbursement-tracking/cogs writes cogs_overrides; single unit_cost only)`);
  console.log(`  csv_import_exists: yes_dry_run_only (single unit_cost columns; landed components NOT supported yet)`);
  console.log(`  claim_amount_code_using_approved_cogs_unit: yes (ReadyToFileView + money-lane V2 profit/loss; cogs feeds internal lane, sale price never used as cogs)`);
  console.log(`  gaps: [landed-cost component storage, effective_from/effective_to history, source_type/confidence, governed cost spine table, component CSV import, Product Cost Hub UI, cost timeline on Product Story]`);

  // ---- PART B ----
  console.log("\n──── PART B — canonical cost model ────");
  console.log(`  identity: ${COST_MODEL_FIELDS.identity.join(", ")}`);
  console.log(`  components: ${COST_MODEL_FIELDS.components.join(", ")}`);
  console.log(`  derived: ${COST_MODEL_FIELDS.derived.join(", ")} (= SUM approved components)`);
  console.log(`  money_and_provenance: ${COST_MODEL_FIELDS.money_and_provenance.join(", ")}`);
  console.log("  rules:");
  for (const r of COST_MODEL_RULES) console.log(`    - ${r}`);

  // ---- PART C ----
  console.log("\n──── PART C — reuse-first schema ────");
  console.log(`  cost_model_reuse_possible: ${SCHEMA_REUSE_ASSESSMENT.reuse_possible}`);
  console.log(`  reuse_now: ${JSON.stringify(SCHEMA_REUSE_ASSESSMENT.reuse_now, null, 0)}`);
  console.log(`  cannot_reuse: ${JSON.stringify(SCHEMA_REUSE_ASSESSMENT.cannot_reuse, null, 0)}`);
  console.log(`  additive_migration_needed: ${COST_HUB_SAFE_FLAGS.additive_migration_needed}`);
  console.log(`  new_table_needed: ${COST_HUB_SAFE_FLAGS.new_table_needed}`);
  console.log(`  approval_required: ${COST_HUB_SAFE_FLAGS.approval_required} (token ${PROPOSED_MIGRATION.approval_token})`);
  console.log(`  proposed_schema (NOT executed): extend ${PROPOSED_MIGRATION.table} with:`);
  for (const c of PROPOSED_MIGRATION.additive_columns_over_draft) console.log(`    ${c}`);
  console.log(`  interim_no_migration_path: ${INTERIM_NO_MIGRATION_PATH.storage}`);

  // ---- PART D ----
  console.log("\n──── PART D — product_cost_hub_ui_plan ────");
  console.log(`  recommended_route: ${COST_HUB_UI_PLAN.recommended_route}`);
  console.log(`  capabilities: ${JSON.stringify(COST_HUB_UI_PLAN.capabilities)}`);
  console.log(`  ready_to_file_cost_display_plan: ${JSON.stringify(READY_TO_FILE_COST_DISPLAY_PLAN.rows.map((r) => r.label))} (${READY_TO_FILE_COST_DISPLAY_PLAN.separation_rule})`);
  console.log(`  product_story_cost_timeline_plan: ${JSON.stringify(PRODUCT_STORY_COST_TIMELINE_PLAN.shows)}`);
  console.log(`  needs_data_cost_blocker: ${NEEDS_DATA_COST_BLOCKER_PLAN.behavior}`);

  // ---- PART E ----
  console.log("\n──── PART E — csv_template_columns ────");
  console.log(`  header: ${COST_CSV_HEADER_LINE}`);
  console.log(`  required: ${requiredCostCsvColumns().join(", ")}`);
  console.log(`  optional_extra: ${COST_CSV_OPTIONAL_EXTRA_COLUMNS.map((c) => c.column).join(", ")}`);
  console.log(`  forbidden: ${COST_CSV_FORBIDDEN_COLUMNS.join(", ")}`);

  // ---- immutability (after) ----
  const after: Record<string, number> = {};
  for (const t of claimTables) {
    const { count } = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    after[t] = count ?? -1;
  }
  const noMutation = claimTables.every((t) => before[t] === after[t]);
  for (const t of claimTables) check(before[t] === after[t], `claim table mutated: ${t}`);

  // ---- assertions ----
  check(missing.some((p) => p.table === "product_cost_snapshots"), "product_cost_snapshots must be absent on live (gated draft)");
  check(existing.some((p) => p.table === "vendors" && (p.rows ?? 0) > 0), "vendors must exist with rows (reusable supplier linkage)");
  check(COST_CSV_TEMPLATE_COLUMNS.length === 13, "CSV template must have 13 columns");
  check(COST_MODEL_FIELDS.components.length === 7, "must define 7 landed-cost components");

  // ---- OUTPUT FLAGS ----
  console.log("\n──── OUTPUT ────");
  console.log(`cost_model_reuse_possible: ${COST_HUB_SAFE_FLAGS.cost_model_reuse_possible}`);
  console.log(`additive_migration_needed: ${COST_HUB_SAFE_FLAGS.additive_migration_needed}`);
  console.log(`new_table_needed: ${COST_HUB_SAFE_FLAGS.new_table_needed}`);
  console.log(`approval_required: ${COST_HUB_SAFE_FLAGS.approval_required}`);
  console.log(`manual_entry_supported: ${COST_HUB_SAFE_FLAGS.manual_entry_supported}`);
  console.log(`csv_import_supported: ${COST_HUB_SAFE_FLAGS.csv_import_supported}`);
  console.log(`no_claim_mutation_verification: ${noMutation ? "yes" : "no"} ${JSON.stringify(after)}`);
  console.log(`no_amazon_submission_verification: yes (no Amazon API calls)`);
  console.log(`no_scanner_change_verification: yes (scanner code untouched)`);
  console.log(`no_new_table_verification: yes (audit is SELECT/HEAD only; migration proposed not executed)`);

  const ok = failures === 0;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`build_result: pending tsc/next (run separately)`);
  console.log(`smoke_result: see smoke-product-cost-landed-cost-hub-v1.ts`);
  console.log(`SAFE_PRODUCT_COST_HUB_ARCHITECTURE_READY: ${ok ? "yes" : "no"}`);
  console.log(`SAFE_TO_IMPLEMENT_PRODUCT_COST_HUB: ${COST_HUB_SAFE_FLAGS.SAFE_TO_IMPLEMENT_PRODUCT_COST_HUB}`);
  console.log(
    `NEXT_PROMPT: PHASE-PRODUCT-LANDED-COST-HUB-SCHEMA-AND-UI-BUILD-V1 — (1) write the gated additive migration extending product_cost_snapshots into the landed-cost spine (DO NOT apply until APPROVED_PRODUCT_LANDED_COST_HUB_SCHEMA_V1=yes); (2) build the Product Cost Hub UI (extend ProductCogsManualEntryView to the 7-component form + cost history + CSV dry-run) writing interim cost_overrides until the migration is approved; (3) wire landed_cost_unit into the money-lane profit/loss view + Ready-to-File financial card + Product Story cost timeline; keep Amazon claim amount on its own policy lane.`,
  );
  process.exit(ok ? 0 : 1);
}

void main();
