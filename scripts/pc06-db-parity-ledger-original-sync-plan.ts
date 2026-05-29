/**
 * PC06 — DB PARITY LEDGER + ORIGINAL SYNC PLAN (read-only)
 *
 *   npx tsx scripts/pc06-db-parity-ledger-original-sync-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/pc06-db-parity-ledger-original-sync-plan";

type LedgerItem = {
  id: string;
  phase: string;
  type: string;
  description: string;
  staging_applied: boolean | string;
  original_applied: boolean | string;
  committed_migration: string | null;
  operator_script: string | null;
  rollback_exists: boolean | string;
  needs_parity: boolean | string;
  safe_for_original_now: boolean | string;
  evidence: string;
  notes?: string;
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

function auditHasRollback(evidenceDir: string): boolean {
  const base = path.join(process.cwd(), ".cursor/audit-reports", evidenceDir.split("/")[0]!);
  const run = evidenceDir.split("/")[1];
  if (!run) return false;
  const dir = path.join(base, run);
  if (!fs.existsSync(dir)) return false;
  const names = fs.readdirSync(dir);
  return names.some((n) => n.startsWith("rollback") && (n.endsWith(".sql") || n.endsWith(".json")));
}

function buildLedger(): LedgerItem[] {
  const items: LedgerItem[] = [
    {
      id: "v189-inventory-deleted-at-filter",
      phase: "scanner/inventory",
      type: "view_ddl",
      description: "Filter soft-deleted return_items from inventory views",
      staging_applied: true,
      original_applied: true,
      committed_migration:
        "supabase/migrations/20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql",
      operator_script:
        "scripts/inventory-views-return-items-deleted-at-filter-v189-staging.ts; scripts/inventory-views-return-items-deleted-at-filter-v189-original.ts",
      rollback_exists: false,
      needs_parity: false,
      safe_for_original_now: true,
      evidence: "inventory-views-return-items-deleted-at-filter-v189/20260523T120000Z/",
    },
    {
      id: "v193-inventory-product-id-columns",
      phase: "scanner/inventory",
      type: "view_ddl",
      description: "Product ID / resolver / linkage columns on v_scanned_items_counted, v_inventory_item_status",
      staging_applied: true,
      original_applied: true,
      committed_migration: null,
      operator_script: "scripts/inventory-views-product-id-columns-v193-original-parity-apply-v195.ts",
      rollback_exists: false,
      needs_parity: false,
      safe_for_original_now: true,
      notes: "No committed migration — PC06A backfill required",
      evidence: "inventory-views-product-id-columns-v193/20260521T185800Z/; v195-original-view-parity-apply/20260522T000100Z/",
    },
    {
      id: "v205-v206-package-code-inventory-views",
      phase: "scanner/inventory",
      type: "view_ddl",
      description: "packages.package_code on v_inventory_item_status (+ related inventory views)",
      staging_applied: true,
      original_applied: true,
      committed_migration: null,
      operator_script:
        "scripts/main-v205-package-code-inventory-views-apply-staging.ts; scripts/main-v206-package-code-inventory-views-original-parity-apply.ts",
      rollback_exists: false,
      needs_parity: false,
      safe_for_original_now: true,
      notes: "DDL in main-v204-package-code-view-ddl-plan; not in supabase/migrations",
      evidence:
        "main-v205-package-code-v-inventory-item-status-apply/20260522T173000Z/; main-v206-package-code-inventory-views-original-parity-apply/20260522T180000Z/",
    },
    {
      id: "packages-package-code-column",
      phase: "scanner",
      type: "table_ddl",
      description: "packages.slip_id → package_code + index",
      staging_applied: true,
      original_applied: "verify",
      committed_migration: "supabase/migrations/20260511140000_packages_package_code_slip_code.sql",
      operator_script: null,
      rollback_exists: false,
      needs_parity: "verify_on_both_refs",
      safe_for_original_now: true,
      evidence: "supabase/migrations/20260511140000_packages_package_code_slip_code.sql",
    },
    {
      id: "pc04-packaging-schema",
      phase: "packaging",
      type: "table_ddl_rls",
      description: "product_packaging_* tables + RLS (PC04A staging + PC04B original)",
      staging_applied: true,
      original_applied: true,
      committed_migration: null,
      operator_script:
        "scripts/pc04a-product-packaging-schema-staging-apply.ts; scripts/pc04b-product-packaging-schema-original-parity-apply.ts",
      rollback_exists: "smoke_test_only",
      needs_parity: false,
      safe_for_original_now: true,
      notes: "PC04 plan proposed DDL; APPLIED both refs via operator scripts — not via migration file",
      evidence:
        "pc04a-product-packaging-schema-staging-apply/20260523T030000Z/; pc04b-product-packaging-schema-original-parity-apply/20260523T213909Z/",
    },
    {
      id: "pc05-packaging-backfill-staging",
      phase: "packaging",
      type: "data_backfill",
      description: "191 AFI packaging profiles/versions + dimensions_current (staging only)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script:
        "scripts/pc05-product-packaging-backfill-staging-execute.ts; scripts/pc05c-product-packaging-backfill-scale-staging.ts",
      rollback_exists: auditHasRollback("pc05c-product-packaging-backfill-scale-staging/20260523T220100Z"),
      needs_parity: true,
      safe_for_original_now: false,
      notes: "Original has empty packaging tables — re-run governed dry-run on original ref",
      evidence:
        "pc05-product-packaging-backfill-staging-execute/20260523T215222Z/; pc05c-product-packaging-backfill-scale-staging/20260523T220100Z/",
    },
    {
      id: "e1-map-bridge-v192",
      phase: "expected_packages",
      type: "map_insert",
      description: "134 product_identifier_map rows (E1 bridge)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/expected-packages-e1-map-bridge-execute-v192.ts",
      rollback_exists: auditHasRollback("expected-packages-e1-map-bridge-execute-v192/20260521T190300Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "expected-packages-e1-map-bridge-execute-v192/20260521T190300Z/",
    },
    {
      id: "e2-product-promotion-v194",
      phase: "expected_packages",
      type: "products_map_insert",
      description: "19 products + 19 map rows (E2 governed promotion)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/expected-packages-e2-product-promotion-execute-v194.ts",
      rollback_exists: auditHasRollback("expected-packages-e2-product-promotion-execute-v194/20260521T204000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "expected-packages-e2-product-promotion-execute-v194/20260521T204000Z/",
    },
    {
      id: "e1b-blocker-materialize-v200",
      phase: "expected_packages",
      type: "products_map_insert",
      description: "10 products + 10 map rows (E1B import spine materialize)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/expected-packages-e1b-blocker-materialize-execute-v200.ts",
      rollback_exists: auditHasRollback("expected-packages-e1b-blocker-materialize-execute-v200/20260522T160000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "expected-packages-e1b-blocker-materialize-execute-v200/20260522T160000Z/",
    },
    {
      id: "pc03b-source-disagreement-map",
      phase: "expected_packages",
      type: "map_insert",
      description: "6 product_identifier_map rows (wave_b closed)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/pc03b-expected-packages-source-disagreement-map-execute.ts",
      rollback_exists: auditHasRollback("pc03b-expected-packages-source-disagreement-map-execute/20260523T020000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "pc03b-expected-packages-source-disagreement-map-execute/20260523T020000Z/",
    },
    {
      id: "pc03a-map-only-plan-zero",
      phase: "expected_packages",
      type: "plan",
      description: "PC03A deterministic map-only — 0 candidates (43 unresolved upstream)",
      staging_applied: false,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/pc03a-expected-return-slip-map-only-execute-plan.ts",
      rollback_exists: false,
      needs_parity: false,
      safe_for_original_now: true,
      evidence: "pc03a-expected-return-slip-map-only-execute-plan/20260523T040000Z/",
    },
    {
      id: "pc07-dirty-source-quarantine-plan",
      phase: "expected_packages",
      type: "plan",
      description: "PC07 triage: 38 dirty + 5 API-404; no source UPDATE",
      staging_applied: false,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/pc07-expected-packages-dirty-source-quarantine-plan.ts",
      rollback_exists: false,
      needs_parity: false,
      safe_for_original_now: true,
      notes: "Blocks map-only until PC07-EXEC dirty source fix",
      evidence: "pc07-expected-packages-dirty-source-quarantine-plan/20260523T060000Z/",
    },
    {
      id: "pc02-sp-api-evidence-not-executed",
      phase: "api",
      type: "evidence_only",
      description: "SP-API catalog evidence — planned; approval false; 0 product/map writes",
      staging_applied: false,
      original_applied: false,
      committed_migration: null,
      operator_script:
        "scripts/pc02-sp-api-evidence-execute.ts; scripts/pc02a-sp-api-evidence-only-dry-run-execute.ts",
      rollback_exists: false,
      needs_parity: false,
      safe_for_original_now: true,
      notes: "5 EP rows in API-404 queue from prior v202 execute-lines",
      evidence:
        "pc02a-sp-api-evidence-only-dry-run-execute/20260523T030000Z/; expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z/",
    },
    {
      id: "afi-resolver-wave-v190a",
      phase: "catalog",
      type: "data_backfill",
      description: "1,795 amazon_amazon_fulfilled_inventory product_id repoints (tier_1_fnsku_exact)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "product-catalog-wave-a-afi-resolver-v190a scripts",
      rollback_exists: "partial",
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "product-catalog-wave-a-afi-resolver-v190a/20260524T210100Z/",
    },
    {
      id: "v203-claim-orphan-fk-null",
      phase: "claims",
      type: "data_backfill",
      description: "NULL 4,736 claim_candidates.resolved_product_id (orphan FK remediation)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/claim-orphan-fk-remediation-v203-staging.ts",
      rollback_exists: auditHasRollback("v203-claim-orphan-fk-remediation/20260522T190000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      notes: "Staging-only claim cleanup wave — original cohort may differ",
      evidence: "v203-claim-orphan-fk-remediation/20260522T190000Z/",
    },
    {
      id: "v204-claim-missing-source-quarantine",
      phase: "claims",
      type: "data_backfill",
      description: "1,543 claim_candidates → quarantined_missing_source (no DELETE)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/claim-missing-source-cleanup-v204-staging.ts",
      rollback_exists: auditHasRollback("v204-claim-missing-source-cleanup/20260522T200000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "v204-claim-missing-source-cleanup/20260522T200000Z/",
    },
    {
      id: "v205-claim-resolver-materialize-pass1",
      phase: "claims",
      type: "data_backfill",
      description: "412 claim rows materialized resolved_product_id (identifier_map proposals)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/claim-resolver-materialize-v205-staging.ts",
      rollback_exists: auditHasRollback("v205-claim-resolver-materialize/20260522T210000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "v205-claim-resolver-materialize/20260522T210000Z/",
    },
    {
      id: "v206-removal-shipments-source-rpid",
      phase: "claims",
      type: "data_backfill",
      description: "4,714 valid shipment RPIDs (4,647 FNSKU + 67 SKU remap; 4 NULL)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/removal-shipments-source-rpid-cleanup-v206-staging.ts",
      rollback_exists: auditHasRollback("v206-removal-shipments-source-rpid-cleanup/20260522T220000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "v206-removal-shipments-source-rpid-cleanup/20260522T220000Z/",
    },
    {
      id: "v207-claim-source-resolved-materialize-pass2",
      phase: "claims",
      type: "data_backfill",
      description: "2,456 claim rows materialized (source_resolved; FK guard)",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/claim-source-resolved-materialize-pass2-v207-staging.ts",
      rollback_exists: auditHasRollback("v207-claim-source-resolved-materialize-pass2/20260522T230000Z"),
      needs_parity: true,
      safe_for_original_now: false,
      evidence: "v207-claim-source-resolved-materialize-pass2/20260522T230000Z/",
    },
    {
      id: "claim-evidence-v193-dryrun",
      phase: "claims",
      type: "plan",
      description: "claim_reference_edge INSERT preview — 0 inserted",
      staging_applied: false,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/claim-evidence-enrichment-dryrun-v193-staging.ts",
      rollback_exists: true,
      needs_parity: false,
      safe_for_original_now: false,
      evidence: "claim-evidence-enrichment-dryrun-v193/20260525T220000Z/",
    },
    {
      id: "claim-evidence-v194-execute-dry-run-only",
      phase: "claims",
      type: "edge_insert",
      description: "V194 execute — dry_run only; 0 claim_reference_edges inserted",
      staging_applied: false,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/claim-evidence-enrichment-execute-v194-staging.ts",
      rollback_exists: true,
      needs_parity: false,
      safe_for_original_now: false,
      notes: "No live inserts — evidence lane gated",
      evidence: "claim-evidence-enrichment-execute-v194/20260525T230000Z/",
    },
    {
      id: "amazon-removals-reingest-v194b-plan",
      phase: "claims",
      type: "repoint_plan",
      description: "338 auto-repoint eligible claim_candidates — plan only, 0 applied",
      staging_applied: false,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/amazon-removals-source-reingest-plan-v194b-staging.ts",
      rollback_exists: true,
      needs_parity: false,
      safe_for_original_now: false,
      evidence: "amazon-removals-source-reingest-plan-v194b/20260526T010000Z/",
    },
    {
      id: "return-items-fake-cleanup-v186",
      phase: "scanner",
      type: "data_backfill",
      description: "4 staging test return_items soft-deleted",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "scripts/return-items-fake-test-cleanup-execute-v186.ts",
      rollback_exists: true,
      needs_parity: false,
      safe_for_original_now: false,
      notes: "Staging test hygiene — do not mirror to original",
      evidence: "return-items-fake-test-cleanup-execute-v186/20260522T230000Z/",
    },
    {
      id: "spine-map-afi-packaging-claims-staging-only",
      phase: "cross_cutting",
      type: "drift_aggregate",
      description:
        "Composite staging-only DML: map/products/AFI/packaging/claim cleanup — highest linkage divergence vs original",
      staging_applied: true,
      original_applied: false,
      committed_migration: null,
      operator_script: "multiple — see original-sync-checklist.md",
      rollback_exists: "partial",
      needs_parity: true,
      safe_for_original_now: false,
      notes:
        "≈175 map + 29 products + 1795 AFI + 191 packaging + claim waves V203–V207; original Vercel Production ref unchanged",
    },
  ];
  return items;
}

function stagingNotOriginal(items: LedgerItem[]): string[] {
  return items
    .filter((i) => i.staging_applied === true && i.original_applied === false)
    .map((i) => i.id);
}

function missingMigrations(items: LedgerItem[]): string[] {
  return items
    .filter(
      (i) =>
        ["view_ddl", "table_ddl", "table_ddl_rls"].includes(i.type) &&
        i.staging_applied === true &&
        !i.committed_migration,
    )
    .map((i) => i.id);
}

function rollbackCoverage(items: LedgerItem[]): { with_rollback: string[]; without: string[] } {
  const withR: string[] = [];
  const without: string[] = [];
  for (const i of items) {
    if (i.rollback_exists === true || i.rollback_exists === "smoke_test_only") withR.push(i.id);
    else if (i.rollback_exists === false) without.push(i.id);
  }
  return { with_rollback: withR, without };
}

function ledgerMd(items: LedgerItem[], summary: Record<string, unknown>): string {
  const lines = [
    "# DB parity ledger",
    "",
    `**Staging:** \`${STAGING_REF}\` · **Original/current:** \`${ORIGINAL_REF}\` · **Future production:** NOT_CREATED_YET`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|------:|`,
    `| Ledger items | ${items.length} |`,
    `| Staging-only DML (needs parity decision) | ${(summary.staging_not_original as string[]).length} |`,
    `| Schema parity OK (both refs) | ${summary.schema_parity_ok} |`,
    `| Missing committed migration (DDL) | ${(summary.missing_committed_migration as string[]).length} |`,
    `| Highest-risk drift | \`${summary.highest_risk_drift_id}\` |`,
    "",
    "## Ledger",
    "",
    "| id | type | staging | original | migration | rollback | needs parity | safe original |",
    "|----|------|---------|----------|-----------|----------|--------------|---------------|",
    ...items.map(
      (i) =>
        `| ${i.id} | ${i.type} | ${i.staging_applied} | ${i.original_applied} | ${i.committed_migration ? "yes" : "no"} | ${i.rollback_exists} | ${i.needs_parity} | ${i.safe_for_original_now} |`,
    ),
    "",
    "## Known items (operator checklist)",
    "",
    "- **package_code** in `v_inventory_item_status` — APPLIED staging + original (V205/V206)",
    "- **Inventory view parity** — V193/V195/V206 on both refs; migrations gap remains",
    "- **PC04 packaging schema** — APPLIED both refs via operator scripts; **no** migration file",
    "- **PC05 packaging backfill** — staging only (191 profiles)",
    "- **PC02 SP-API** — evidence dry-runs only; governed execute not approved",
    "- **PC03A map-only** — 0 candidates",
    "- **PC07** — 38 dirty + 5 API-404 triage plan; no writes",
    "- **Claim evidence V194** — dry-run only; 0 edge inserts",
    "- **Amazon removals V194B** — plan only; 0 live repoint",
    "- **Claims V203–V207** — staging executes only (orphan NULL, quarantine, materialize, shipment RPID)",
  ];
  return lines.join("\n") + "\n";
}

function main(): void {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const items = buildLedger();
  const stagingOnly = stagingNotOriginal(items);
  const missingMigr = missingMigrations(items);
  const rollback = rollbackCoverage(items);
  const schemaOk = items.filter(
    (i) => i.original_applied === true && ["view_ddl", "table_ddl", "table_ddl_rls"].includes(i.type),
  ).length;

  const summary = {
    ledger_items: items.length,
    schema_parity_ok: schemaOk,
    staging_only_dml: stagingOnly.length,
    staging_not_original: stagingOnly,
    missing_committed_migration: missingMigr,
    highest_risk_drift_id: "spine-map-afi-packaging-claims-staging-only",
    next_prompt: "PC06A — COMMIT OPERATOR-ONLY DDL TO SUPABASE MIGRATIONS",
  };

  const ledgerJson = {
    prompt: "PC06 — DB PARITY LEDGER + ORIGINAL SYNC PLAN",
    run_id: runId,
    branch,
    mode: "read_only_docs_plan",
    topology: {
      staging_ref: STAGING_REF,
      original_ref: ORIGINAL_REF,
      future_production_ref: "NOT_CREATED_YET",
    },
    summary,
    items,
  };

  fs.writeFileSync(path.join(outDir, "db-parity-ledger.json"), JSON.stringify(ledgerJson, null, 2));
  fs.writeFileSync(path.join(outDir, "db-parity-ledger.md"), ledgerMd(items, summary));

  fs.writeFileSync(
    path.join(outDir, "original-sync-checklist.md"),
    [
      "# Original sync checklist",
      "",
      "**Do not execute from this document.** Replay on `kxsvedvpjldygtdbylsy` only with per-wave approval.",
      "",
      "## Wave 0 — Schema (verify, no DML)",
      "",
      "- [ ] PC04B packaging tables + RLS (`pc04b-product-packaging-schema-original-parity-apply/20260523T213909Z/`)",
      "- [ ] V193/V195 inventory product columns on original",
      "- [ ] V205/V206 package_code inventory views on original",
      "- [ ] V189 deleted_at filter on original",
      "",
      "## Wave 1 — Product spine DML (original dry-run first)",
      "",
      "- [ ] E1 map bridge (134 rows staging)",
      "- [ ] E2 promotion (19+19 staging)",
      "- [ ] E1B materialize (10+10 staging)",
      "- [ ] PC03B disagreement map (6 staging)",
      "- [ ] AFI resolver V190A (1,795 repoints staging)",
      "",
      "## Wave 2 — Expected packages upstream (before map-only)",
      "",
      "- [ ] PC07-EXEC dirty source fix (38 rows) — approval `pc07-expected-packages-dirty-source-fix-execute-approval.md`",
      "- [ ] PC03A re-run map-only plan",
      "- [ ] PC02C / PC07 API-404 evidence queue (5 rows) — no product create",
      "",
      "## Wave 3 — Packaging backfill",
      "",
      "- [ ] PC05 dry-run on **original** (do not copy staging UUIDs)",
      "- [ ] PC05-EXECUTE + activate with separate approvals",
      "",
      "## Wave 4 — Claims (staging proofs; original separate)",
      "",
      "- [ ] V203 orphan FK NULL — re-census on original",
      "- [ ] V204 missing-source quarantine",
      "- [ ] V206 shipment source RPID cleanup",
      "- [ ] V205/V207 materialize passes",
      "- [ ] V194 claim_reference_edges — only after Wave B + execute approval",
      "- [ ] V194B removals repoint — plan only today",
      "",
      "## Wave 5 — PC06A migrations (repo only)",
      "",
      "- [ ] Commit PC04 + V193 + V205 DDL to `supabase/migrations/`",
      "",
      "**Gate:** Re-run PC01 baseline + PC06 ledger on original after each wave.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "migration-vs-operator-gap.md"),
    [
      "# Migration vs operator gap",
      "",
      "## DDL without committed migration",
      "",
      ...missingMigr.map((id) => `- **${id}**`),
      "",
      "## Remediation (PC06A — no apply in PC06)",
      "",
      "1. Export `ddl-used.sql` / `ddl-plan.sql` from audit folders into `supabase/migrations/`",
      "2. Mark operator scripts as idempotent wrappers (V189 pattern)",
      "3. Apply order: v180 → v189 → v193 → v205 → PC04",
      "",
      `| DDL gaps | ${missingMigr.length} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-coverage.md"),
    [
      "# Rollback coverage",
      "",
      `| With rollback artifact | ${rollback.with_rollback.length} |`,
      `| Without rollback on disk | ${rollback.without.length} |`,
      "",
      "## With rollback",
      "",
      ...rollback.with_rollback.map((id) => `- ${id}`),
      "",
      "## Without rollback (DDL/views or plan-only)",
      "",
      ...rollback.without.map((id) => `- ${id}`),
      "",
      "**Policy:** No original DML without staging-tested `rollback.sql` or preimage JSON.",
    ].join("\n") + "\n",
  );

  const memoryUpdates = `# Memory updates (PC06 ${runId})

Apply to \`.ai-memory/DATABASE_CONTRACT.md\` and \`.ai-memory/NEXT_ACTIONS.md\`:

- DB parity policy: staging first; original DML via dry-run replay; no UUID copy
- Staging-only: map/products/AFI/packaging/claims V203–V207
- Schema parity OK: PC04, V193/V195/V206, V189 on both refs
- Missing migrations: PC04 packaging, V193 inventory columns, V205 package_code views
- Next: **PC06A** commit DDL migrations; then **PC07-EXEC** dirty source fix
`;
  fs.writeFileSync(path.join(outDir, "memory-updates.md"), memoryUpdates);

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only PC06 — no DB/API/original writes",
      "- Future production project NOT_CREATED_YET",
      `- ${stagingOnly.length} staging-only DML waves — original parity blocked until per-wave dry-run + approval`,
      `- ${missingMigr.length} operator-applied DDL waves lack committed migrations`,
      "- PC07 dirty cohort (38) blocks EP map-only",
      "- Claim V194 edge insert + V194B repoint — plan/dry-run only",
      "- PC02 SP-API governed execute — approval false",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PC06 — DB PARITY LEDGER + ORIGINAL SYNC PLAN",
    run_id: runId,
    branch,
    mode: "read_only_docs_plan",
    owner: "Main/user",
    topology: {
      staging_ref: STAGING_REF,
      original_ref: ORIGINAL_REF,
      future_production_ref: "NOT_CREATED_YET",
    },
    ok: true,
    db_mutated: false,
    amazon_api_called: false,
    artifacts: [
      "db-parity-ledger.md",
      "db-parity-ledger.json",
      "original-sync-checklist.md",
      "migration-vs-operator-gap.md",
      "rollback-coverage.md",
      "memory-updates.md",
      "blockers.md",
      "manifest.json",
    ],
    summary: {
      ledger_items: items.length,
      staging_not_original_count: stagingOnly.length,
      staging_not_original: stagingOnly,
      missing_committed_migration: missingMigr,
      highest_risk_drift: summary.highest_risk_drift_id,
      next_prompt: summary.next_prompt,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Apply memory doc updates inline (user required)
  updateMemoryFiles(runId, summary, stagingOnly.length);

  console.log(JSON.stringify(manifest, null, 2));
}

function updateMemoryFiles(
  runId: string,
  summary: { highest_risk_drift_id: string; next_prompt: string },
  stagingOnlyCount: number,
): void {
  const dbPath = path.join(process.cwd(), ".ai-memory/DATABASE_CONTRACT.md");
  let db = fs.readFileSync(dbPath, "utf8");

  const paritySection = `## DB parity policy (PC06)

**Refs:** staging \`${STAGING_REF}\` · original/current \`${ORIGINAL_REF}\` · future production **NOT_CREATED_YET**.

| Rule | Contract |
|---|---|
| Staging first | All governed DDL/DML proofs run on staging before original |
| Original parity DDL | Use original-parity script pattern (PC04B, V195, V206, V189-original) — capture pre-viewdefs |
| Original parity DML | **Never** copy staging UUIDs; re-run dry-run on original ref + separate operator approval |
| Migrations | Operator-only DDL must be backfilled to \`supabase/migrations/\` (see PC06 migration-vs-operator-gap) |
| Rollback | No original DML without staging-tested \`rollback.sql\` or preimage JSON |
| Vercel Production | Points at original ref — not staging; not future production |

**Known staging-only DML:** product spine map/products (~175 map, ~29 products), AFI repoints (~1,795), packaging backfill (191 profiles), claims cleanup V203–V207 (orphan NULL, quarantine, materialize, shipment RPID).

**Schema parity OK (both refs):** PC04 packaging tables+RLS, V193/V195 inventory product columns, V205/V206 package_code views, V189 deleted_at filter.

Evidence: \`pc06-db-parity-ledger-original-sync-plan/${runId}/db-parity-ledger.json\``;

  if (db.includes("## DB parity policy (PC06)")) {
    db = db.replace(/## DB parity policy \(PC06\)[\s\S]*?(?=\n## )/, `${paritySection}\n\n`);
  } else {
    db = db.replace(/\n## Forbidden/, `\n\n${paritySection}\n\n## Forbidden`);
  }
  db = db.replace(
    /\| PC06 parity ledger \|[^\n]+\n/,
    `| PC06 parity ledger | **PASS** — \`pc06-db-parity-ledger-original-sync-plan/${runId}/\` |\n`,
  );
  fs.writeFileSync(dbPath, db);

  const nextPath = path.join(process.cwd(), ".ai-memory/NEXT_ACTIONS.md");
  let next = fs.readFileSync(nextPath, "utf8");
  if (!next.includes(`PC06 DB parity ledger **PASS** (\`${runId}\`)`)) {
    next = next.replace(
      /- \[x\] PC06 DB parity ledger[^\n]*\n/,
      `- [x] PC06 DB parity ledger **PASS** (\`${runId}\`)\n`,
    );
  }
  const p1 = `## P1 — Next (ordered)

1. **${summary.next_prompt}** — commit PC04 + V193 + V205 DDL from audit artifacts (no apply)
2. **PC07-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE** — 38 rows (approval-gated)
3. **PC07 — ORIGINAL SPINE DML PARITY PLAN** — ${stagingOnlyCount} staging-only waves; per-wave dry-run on original
4. **PC02C operator CSV follow-through** — 5 API-404 rows
5. **CLAIM-CLEANUP original parity** — replay V203–V207 pattern on original after staging proofs`;
  next = next.replace(/## P1 — Next \(ordered\)[\s\S]*?(?=\n---\n\n## Blocked)/, `${p1}\n`);
  fs.writeFileSync(nextPath, next);
}

main();
