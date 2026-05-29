/**
 * LAYERED DB SEPARATION PLAN PHASE1 (read-only architecture)
 *
 *   npx tsx scripts/layered-db-separation-plan-phase1.ts --run-id=<UTC_Z>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/layered-db-separation-plan-phase1";

type Surface = {
  table: string;
  layer: "L0" | "L1" | "L2" | "L3";
  role: string;
  exists: boolean;
  row_count: number | null;
  notes: string;
};

const SURFACES: Omit<Surface, "exists" | "row_count">[] = [
  { table: "raw_report_uploads", layer: "L0", role: "Upload manifest + storage pointer", notes: "Phase 1 chunk/process; SP-API synthetic uploads" },
  { table: "amazon_staging", layer: "L0", role: "Normalized row JSON per upload line", notes: "Org+upload keyed; pre-sync landing" },
  { table: "file_processing_status", layer: "L0", role: "Pipeline progress / FPS keys", notes: "Tied to upload_id" },
  { table: "amazon_removals", layer: "L1", role: "Removal order detail domain", notes: "From REMOVAL_ORDER sync or CSV" },
  { table: "amazon_removal_shipments", layer: "L1", role: "Removal shipment domain", notes: "Tracking/carrier normalized at rebuild/view" },
  { table: "removal_item_allocations", layer: "L1", role: "Detail↔shipment allocation graph", notes: "Rebuild helper" },
  { table: "amazon_returns", layer: "L1", role: "Amazon returns import domain", notes: "Import sync surface" },
  { table: "amazon_inventory_ledger", layer: "L1", role: "Ledger import domain", notes: "Bulk linkage waves" },
  { table: "financial_reference_resolver", layer: "L1", role: "Financial TRID key registry", notes: "Phase 4 generic; reused by claims" },
  { table: "products", layer: "L1", role: "PIM catalog spine", notes: "Shared read by L2/L3; governed writes only" },
  { table: "product_identifier_map", layer: "L1", role: "Resolver bridge", notes: "Never blind bulk clone between envs" },
  { table: "expected_packages", layer: "L2", role: "Operational expected/receive spine", notes: "Rebuild from L1 removals" },
  { table: "return_items", layer: "L2", role: "Scanner/receive line grain", notes: "expected_item_id item-level receive" },
  { table: "packages", layer: "L2", role: "Physical package hierarchy", notes: "Scanner parent" },
  { table: "pallets", layer: "L2", role: "Physical pallet hierarchy", notes: "Scanner parent" },
  { table: "slip_contents", layer: "L2", role: "Slip/box contents", notes: "Scanner linkage" },
  { table: "claim_candidates", layer: "L3", role: "Detection inbox", notes: "Pre-claim_line promotion target" },
  { table: "claim_candidate_drafts", layer: "L3", role: "V2 draft / evidence anchor", notes: "Edges + enrichment" },
  { table: "claim_lines", layer: "L3", role: "Operational claim line (planned)", notes: "Prerequisite for TRID foundation" },
  { table: "claim_reference_edges", layer: "L3", role: "Evidence graph edges", notes: "FRR trid_key linkage" },
  { table: "claim_filing_requests", layer: "L3", role: "Filing handoff envelope", notes: "Many lines → one case" },
  { table: "trid_entities", layer: "L3", role: "TRID lifecycle (draft migration)", notes: "Not applied yet" },
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);

  const inventory: Surface[] = [];
  if (dbUrl && ref === STAGING_REF && getStagingProjectRef({ loadEnv: false }) === STAGING_REF) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '90s'");

    for (const s of SURFACES) {
      const ex = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS ok`,
        [s.table],
      );
      const exists = Boolean((ex.rows[0] as { ok: boolean }).ok);
      let row_count: number | null = null;
      if (exists) {
        try {
          const c = await client.query(`SELECT COUNT(*)::bigint AS c FROM public.${s.table}`);
          row_count = Number((c.rows[0] as { c: string }).c);
        } catch {
          row_count = null;
        }
      }
      inventory.push({ ...s, exists, row_count });
    }

    const schemas = await client.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 1`,
    );
    await client.end();

    fs.writeFileSync(
      path.join(outDir, "schema-census.json"),
      JSON.stringify({ staging_ref: STAGING_REF, schemas: schemas.rows, inventory }, null, 2),
    );
  } else {
    for (const s of SURFACES) {
      inventory.push({ ...s, exists: false, row_count: null });
    }
  }

  const phase1SplitNow = false;
  const recommendedStrategy =
    "same_supabase_project_logical_layers_strict_naming_rls_phase1";

  const architecture = [
    "# Target layered architecture",
    "",
    "```text",
    "L0 raw/archive     → raw_report_uploads, storage raw-reports, amazon_staging, FPS",
    "L1 domain/ingest   → amazon_* typed tables, FRR, products + product_identifier_map",
    "L2 operational     → expected_packages, return_items, packages/pallets/slip_contents",
    "L3 claims/TRID/AI  → claim_*, trid_*, filing; reads L1+L2; no blind product create",
    "```",
    "",
    "## Data flow (removal + scanner Phase1)",
    "",
    "```mermaid",
    "flowchart TB",
    "  subgraph L0[L0 raw/archive]",
    "    RRU[raw_report_uploads]",
    "    STG[amazon_staging]",
    "    BLOB[storage raw-reports]",
    "  end",
    "  subgraph L1[L1 domain]",
    "    AR[amazon_removals]",
    "    ARS[amazon_removal_shipments]",
    "    PIM[products + product_identifier_map]",
    "    FRR[financial_reference_resolver]",
    "  end",
    "  subgraph L2[L2 operational]",
    "    EP[expected_packages]",
    "    RI[return_items]",
    "    PKG[packages / pallets]",
    "  end",
    "  subgraph L3[L3 claims]",
    "    CC[claim_candidates / drafts]",
    "    CL[claim_lines planned]",
    "    TRID[trid_entities planned]",
    "  end",
    "  RRU --> STG",
    "  STG --> AR",
    "  STG --> ARS",
    "  AR --> EP",
    "  ARS --> EP",
    "  EP --> RI",
    "  PIM --> EP",
    "  PIM --> RI",
    "  RI --> CL",
    "  EP --> CL",
    "  CL --> TRID",
    "  FRR --> TRID",
    "```",
  ].join("\n");

  const currentSurfaces = [
    "# Current surface inventory (staging census)",
    "",
    "| Layer | Table | Exists | Rows | Role |",
    "|-------|-------|--------|-----:|------|",
    ...inventory.map(
      (s) =>
        `| ${s.layer} | \`${s.table}\` | ${s.exists ? "yes" : "no"} | ${s.row_count ?? "—"} | ${s.role} |`,
    ),
    "",
    "## Observations",
    "",
    "- **Single `public` schema** today — all layers co-mingle with RLS org scoping.",
    "- **L0→L1** pipeline: chunk → process → stage → sync (`lib/import-sync-mappers.ts`, SP-API fetch).",
    "- **L1→L2** removal path: `rebuild_expected_packages_from_removals` + item-level receive RPCs.",
    "- **L3** depends on L2 linkage (`resolved_product_id`) and L1 FRR for financial TRID.",
  ].join("\n");

  const phase1Strategy = [
    "# Phase1 practical approach",
    "",
    "## Decision: **split physical DB now? NO**",
    "",
    "| Option | Phase1 verdict | Why |",
    "|--------|----------------|-----|",
    "| **A. Same Supabase project, logical layers** | **RECOMMENDED** | Phase1 scanner/original parity in flight; cross-layer FKs dense; one RLS model |",
    "| B. Separate schemas (`ingest`, `ops`, `claims`) same project | **Defer to Phase2** | Requires migration + search_path/PostgREST exposure work |",
    "| C. Separate Supabase project for L0/L1 archive | **Defer post-Phase1** | Breaks FK joins, doubles env parity cost, blocks Neda scanner delivery |",
    "",
    "## Phase1 layer discipline (no new project)",
    "",
    "1. **Naming prefix** in docs/code: `L0_*`, domain tables unchanged but tagged in DATABASE_CONTRACT.",
    "2. **Write boundaries:** ingestion routes only touch L0/L1; scanner only L2; claims scripts L3.",
    "3. **Forbidden cross-layer shortcuts:** no scanner UI writing `amazon_staging`; no claims auto-create products.",
    "4. **Retention policy (plan only):** L0 staging rows purgeable by upload_id after successful sync + audit preimage.",
    "5. **Original parity:** replicate **logical** layers on original via governed executes, not split DB.",
    "",
    "## When to split physically",
    "",
    "| Trigger | Action |",
    "|---------|--------|",
    "| Staging DB > practical backup/restore window | L0 archive → cold storage or read replica |",
    "| Ingestion WAL contention affects scanner latency | Move L0 to separate project with ETL publish |",
    "| Claims/TRID audit requires immutable ingest | L0 append-only archive DB |",
    "| Production cutover (`NOT_CREATED_YET`) | **New** prod ref with layered schemas from day one |",
  ].join("\n");

  const risks = [
    "# Split timing & risks",
    "",
    "## Risks if split too early (Phase1)",
    "",
    "| Risk | Impact |",
    "|------|--------|",
    "| Broken FKs EP↔removals↔return_items | Scanner + rebuild fail |",
    "| Dual parity (staging + original + archive) | Operator error, drift |",
    "| PostgREST / Supabase client single-URL assumption | App rewrites across codebase |",
    "| Phase1 original parity wave C in progress | Delay production scanner |",
    "",
    "## Risks if never split",
    "",
    "| Risk | Mitigation |",
    "|------|------------|",
    "| Ingestion bulk locks operational reads | Batch sizing + statement_timeout (existing) |",
    "| L0 staging bloat | Upload-scoped purge after sync proof |",
    "| Claims graph mixed with ingest | Logical layer docs + RLS + governed scripts |",
    "",
    "## Recommended timeline",
    "",
    "| Phase | Milestone |",
    "|-------|-----------|",
    "| **Phase1 (now)** | Logical layers + write boundaries; same project |",
    "| **Phase1.5** | Optional `ingest` schema for new tables only (additive) |",
    "| **Phase2** | Physical archive project for L0 cold storage |",
    "| **Production** | New ref with layered DDL at cutover |",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "layer-architecture.md"), architecture + "\n");
  fs.writeFileSync(path.join(outDir, "current-surface-inventory.md"), currentSurfaces + "\n");
  fs.writeFileSync(path.join(outDir, "phase1-strategy.md"), phase1Strategy + "\n");
  fs.writeFileSync(path.join(outDir, "split-timing-risks.md"), risks + "\n");
  fs.writeFileSync(path.join(outDir, "blockers.md"), "- None (read-only plan).\n");

  const nextPrompt =
    "LAYERED-DB-PHASE1-CONTRACT-UPDATE — append layer tags to DATABASE_CONTRACT + ingestion write-boundary checklist";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "LAYERED-DB-SEPARATION-PLAN-PHASE1",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        phase1_split_now: phase1SplitNow,
        recommended_layer_strategy: recommendedStrategy,
        surfaces_inventoried: inventory.length,
        exact_next_prompt: nextPrompt,
        no_db_writes: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        phase1_split_now: phase1SplitNow,
        recommended_layer_strategy: recommendedStrategy,
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
