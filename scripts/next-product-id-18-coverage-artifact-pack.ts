/**
 * NEXT-PRODUCT-ID-18B — Universal product resolution coverage artifact pack (docs only).
 *
 *   npx tsx scripts/next-product-id-18-coverage-artifact-pack.ts
 *
 * Writes: .cursor/audit-reports/next-product-id-18/<run_id>/ — no DB, no migrations.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { mkRunDir, mkRunId, writeJson } from "../lib/audits/product-seed-output";

type MatrixRow = {
  table: string;
  resolverCols: "Y" | "Partial" | "N";
  dryRunSlice4: "Y" | "N";
  postSyncResolver: "Y" | "N";
  ledgerPhase4: "Y" | "N";
  claimsSurface: string;
  lane: "A" | "B" | "C" | "—" | "A+C";
  notes: string;
}

const MATRIX: MatrixRow[] = [
  { table: "amazon_fba_inventory", resolverCols: "Y", dryRunSlice4: "Y", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "via source_row", lane: "B", notes: "Resolver cols 20260813120000; post-sync not wired; governed waves (NEXT-PRODUCT-ID-15/17)." },
  { table: "amazon_manage_fba_inventory", resolverCols: "Y", dryRunSlice4: "Y", postSyncResolver: "Y", ledgerPhase4: "N", claimsSurface: "if linked", lane: "A", notes: "20260642 + resolveAmazonImportProducts on MANAGE_FBA_INVENTORY sync." },
  { table: "amazon_inventory_ledger", resolverCols: "Y", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "Y", claimsSurface: "if linked", lane: "A+C", notes: "resolve* supports table but sync calls Phase 4 enrich (map+ledger PATCH) not post-sync block." },
  { table: "amazon_reserved_inventory", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "—", lane: "—", notes: "Archive table; no resolved_* migration in 20260642 set; needs design." },
  { table: "amazon_all_orders", resolverCols: "Y", dryRunSlice4: "N", postSyncResolver: "Y", ledgerPhase4: "N", claimsSurface: "context joins", lane: "A", notes: "20260642; ALL_ORDERS post-sync resolver; transactions can inherit." },
  { table: "amazon_returns", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "operational resolve", lane: "—", notes: "CLAIM_SUPPORTED; alternate keys; add resolver cols + policy for writeback." },
  { table: "amazon_removals", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "operational resolve", lane: "—", notes: "CLAIM_SUPPORTED; high-touch removals domain." },
  { table: "amazon_removal_shipments", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "operational resolve", lane: "—", notes: "CLAIM_SUPPORTED; shipment tree / expected_packages." },
  { table: "amazon_reimbursements", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "—", lane: "—", notes: "Financial archive; sku column; resolver pattern TBD." },
  { table: "amazon_settlements", resolverCols: "Y", dryRunSlice4: "N", postSyncResolver: "Y", ledgerPhase4: "N", claimsSurface: "—", lane: "A", notes: "20260642; SETTLEMENT post-sync." },
  { table: "amazon_transactions", resolverCols: "Y", dryRunSlice4: "N", postSyncResolver: "Y", ledgerPhase4: "N", claimsSurface: "—", lane: "A", notes: "joinAllOrders optional inheritance from all_orders." },
  { table: "amazon_amazon_fulfilled_inventory", resolverCols: "Y", dryRunSlice4: "Y", postSyncResolver: "Y", ledgerPhase4: "N", claimsSurface: "if linked", lane: "A", notes: "20260642; AMAZON_FULFILLED_INVENTORY sync." },
  { table: "catalog_products", resolverCols: "N", dryRunSlice4: "Y", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "PIM / listings", lane: "—", notes: "Listing snapshot; dry-run bucket 1 uses product rows, not resolved_* on table." },
  { table: "claim_candidate_drafts", resolverCols: "Y", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "V2 staging", lane: "—", notes: "20260814120000 resolved_product_id + product_id; promotion workflow." },
  { table: "claim_candidates (legacy)", resolverCols: "Partial", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "inbox + schema", lane: "—", notes: "claim-inbox-schema / projection; resolved_product_id on candidates." },
  { table: "returns", resolverCols: "Partial", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "operational", lane: "—", notes: "product_id + identifiers; no resolved_product_id column pattern." },
  { table: "packages", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "evidence API", lane: "—", notes: "Warehouse; link via pallet/order/LPN; product resolution via joins not row resolver." },
  { table: "pallets", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "evidence API", lane: "—", notes: "Carrier/order metadata; inherit to packages." },
  { table: "slip_contents", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "evidence API", lane: "—", notes: "Parsed slip lines; SKU text not same as amazon_fba_inventory resolver grain." },
  { table: "Google Sheets / manual catalog", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "—", lane: "—", notes: "backend-python /etl/sync-google-sheets; preview vs apply; align with PIM safe_new policy." },
  { table: "Walmart / Shopify (future)", resolverCols: "N", dryRunSlice4: "N", postSyncResolver: "N", ledgerPhase4: "N", claimsSurface: "—", lane: "—", notes: "No first-class `amazon_*`-style raw tables in repo; adapters/settings mention Walmart." },
];

function matrixMd(): string {
  const header =
    "| Table | Resolver cols | Dry-run slice-4 | Post-sync `resolveAmazonImportProducts` | Ledger Phase 4 | Claims / ops | Lane | Notes |\n|-------|--------------|-----------------|----------------------------------------|----------------|--------------|------|-------|\n";
  return (
    `# Source table coverage matrix — NEXT-PRODUCT-ID-18

<!-- markdownlint-disable MD013 -->

**Legend — lanes:** **A** = automatic post-sync PATCH (map lookup, no map mutation by resolver). **B** = controlled wave / governed CSV + preimage + verify. **C** = Ledger Phase 4 (may upsert/enrich \`product_identifier_map\` and PATCH ledger — see governance doc). **—** = not wired / different model.

` +
    header +
    MATRIX.map(
      (r) =>
        `| ${r.table} | ${r.resolverCols} | ${r.dryRunSlice4} | ${r.postSyncResolver} | ${r.ledgerPhase4} | ${r.claimsSurface} | ${r.lane} | ${r.notes} |`,
    ).join("\n") +
    "\n"
  );
}

function main(): void {
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "next-product-id-18"), runId);
  const logPath = path.join(outDir, "logs", "product-id-18.ndjson");
  const log = (o: Record<string, unknown>) =>
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n", "utf8");

  log({ event: "start", runId, matrixRows: MATRIX.length });

  const summary = `# Universal product resolution summary — NEXT-PRODUCT-ID-18

**Run ID:** \`${runId}\`

## Purpose

Define how every import, API, manual, and scanner-originated row should eventually: **preserve raw identifiers**, **resolve to \`products.id\` when safe**, **queue or create products only under policy**, **write \`resolved_product_id\` (and related status) back to operational/archive rows**, and keep **\`product_id\` / \`resolved_product_id\` consistent** across claims, inventory, warehouse surfaces, reports, and integrations.

## Resolver lanes

### Lane A — Automatic post-sync PATCH

Implemented in [\`lib/amazon-import-product-resolver.ts\`](../../lib/amazon-import-product-resolver.ts). After a successful CSV sync for selected \`AmazonSyncKind\` values, [\`app/api/settings/imports/sync/route.ts\`](../../app/api/settings/imports/sync/route.ts) calls \`resolveAmazonImportProducts\` for the same \`(organization_id, upload_id, store_id)\` slice. Patches \`resolved_product_id\`, \`resolved_catalog_product_id\`, \`identifier_resolution_status\`, \`identifier_resolution_confidence\` using **read-only** \`product_identifier_map\` + \`products\` lookups (resolver does **not** mutate the map).

**Tables in union type today:** \`amazon_all_orders\`, \`amazon_settlements\`, \`amazon_transactions\`, \`amazon_inventory_ledger\`, \`amazon_manage_fba_inventory\`, \`amazon_amazon_fulfilled_inventory\`.

### Lane B — Controlled wave / governed backfill

Used where automatic post-sync is **not** enabled or risk requires CSV eligibility, preimage, signoff, staged \`UPDATE\`, and post-verify — pattern: NEXT-PRODUCT-ID-11 / 15 / 17 / 17b for **\`amazon_fba_inventory\`**.

### Lane C — Ledger Phase 4 map enrichment

[\`lib/inventory-ledger-generic-completion.ts\`](../../lib/inventory-ledger-generic-completion.ts) runs [\`lib/inventory-ledger-identifier-enrich.ts\`](../../lib/inventory-ledger-identifier-enrich.ts) after **INVENTORY_LEDGER** sync when Phase 4 is needed. This path **inserts/updates \`product_identifier_map\`** bridge rows and **PATCHes \`amazon_inventory_ledger\`** resolver columns — different governance and idempotency expectations than Lane A alone.

## Claims and inbox

[\`lib/claim-inbox-projection.ts\`](../../lib/claim-inbox-projection.ts) consumes \`resolved_product_id\` on supported source rows when present. [\`lib/claim-inbox-schema.ts\`](../../lib/claim-inbox-schema.ts) probes column sets. [\`lib/claim-operational-source-resolve.ts\`](../../lib/claim-operational-source-resolve.ts) resolves operational \`amazon_returns\` / \`amazon_removals\` / \`amazon_removal_shipments\` / \`returns\` when \`source_row_id\` is fragile — **never auto-merge** ambiguous operational hits.

## Ten key rules (normative)

1. **Scope:** match identifiers under **\`organization_id\` + \`store_id\`** (store required for map-backed resolver paths in practice).
2. **Raw preservation:** keep \`raw_data\` / \`raw_payload\` / native columns; resolver outputs are additive columns.
3. **Titles:** **never** use title/name alone to auto-merge products (classifier bucket 7 / human_review).
4. **UPC/GTIN:** not globally trusted for auto-create; UPC-only → review (see classifier bucket 6).
5. **safe_new:** always **dry-run + signoff** before any product creation job; never auto-create on raw import alone.
6. **Ambiguity:** unresolved / ambiguous → review queues, not silent picks.
7. **API parity:** API ingestion that lands rows in the same domain tables must run the **same** resolver lane as file sync (no forked matching logic).
8. **Lineage:** \`source_upload_id\` / \`upload_id\` + file identity (\`source_file_sha256\`, \`source_physical_row_number\`, \`source_line_hash\` per registry) for replay and audits.
9. **Bridge:** \`product_identifier_map\` remains the **canonical** identifier bridge; resolver PATCH does not silently rewrite bridge semantics.
10. **Listings:** \`catalog_products\` remains **listing / PIM snapshot** — not the same lifecycle as operational \`products\` rows unless explicitly wired.

## References

- Migrations: [\`20260642_amazon_import_file_alignment.sql\`](../../supabase/migrations/20260642_amazon_import_file_alignment.sql), [\`20260813120000_amazon_fba_inventory_resolver_columns.sql\`](../../supabase/migrations/20260813120000_amazon_fba_inventory_resolver_columns.sql), [\`20260814120000_claim_candidate_drafts.sql\`](../../supabase/migrations/20260814120000_claim_candidate_drafts.sql)
- Classifier: [\`lib/audits/product-seed-classifier.ts\`](../../lib/audits/product-seed-classifier.ts)
- Dry-run orchestrator (slice-4 wired tables): [\`scripts/product-seed-dry-run-report.ts\`](../../scripts/product-seed-dry-run-report.ts)
`;

  fs.writeFileSync(path.join(outDir, "universal-product-resolution-summary.md"), summary, "utf8");

  fs.writeFileSync(path.join(outDir, "source-table-coverage-matrix.md"), matrixMd(), "utf8");

  const gaps = `# Required column gap analysis — NEXT-PRODUCT-ID-18

## Resolver column pattern (target)

For archive/operational Amazon domain rows aligned with Lane A/B:

- \`resolved_product_id uuid\`, \`resolved_catalog_product_id uuid\`
- \`identifier_resolution_status text\`, \`identifier_resolution_confidence numeric\`
- Typed identifier columns where possible (\`sku\`, \`asin\`, \`fnsku\`) + \`raw_data\` / \`raw_payload\`
- \`source_upload_id\` or \`upload_id\` → \`raw_report_uploads\` lineage

## Present (selected)

| Table | Migration / evidence |
|-------|---------------------|
| \`amazon_all_orders\`, \`amazon_settlements\`, \`amazon_transactions\`, \`amazon_manage_fba_inventory\`, \`amazon_amazon_fulfilled_inventory\` | [\`20260642_amazon_import_file_alignment.sql\`](../../supabase/migrations/20260642_amazon_import_file_alignment.sql) |
| \`amazon_inventory_ledger\` | Resolver columns + comments [\`20260620_product_identifier_map_ledger_enrichment.sql\`](../../supabase/migrations/20260620_product_identifier_map_ledger_enrichment.sql); typed sku/asin in 20260642 |
| \`amazon_fba_inventory\` | [\`20260813120000_amazon_fba_inventory_resolver_columns.sql\`](../../supabase/migrations/20260813120000_amazon_fba_inventory_resolver_columns.sql) |
| \`claim_candidate_drafts\` | \`product_id\`, \`resolved_product_id\` [\`20260814120000_claim_candidate_drafts.sql\`](../../supabase/migrations/20260814120000_claim_candidate_drafts.sql) |

## Gaps (proposed future migrations — not authored here)

| Table | Gap |
|-------|-----|
| \`amazon_returns\`, \`amazon_removals\`, \`amazon_removal_shipments\` | Add same resolver quad + indexes when policy approves writeback; today claims use operational alternate keys without row resolver columns. |
| \`amazon_reserved_inventory\`, \`amazon_reimbursements\` | No \`resolved_product_id\` in 20260642 set; need additive columns + join keys documented per report shape. |
| \`packages\`, \`pallets\`, \`slip_contents\` | Optional \`resolved_product_id\` **only** if product-backed UX requires it; otherwise join \`returns\` / \`amazon_*\` / LPN paths. |

## Dry-run coverage gap

[\`scripts/product-seed-dry-run-report.ts\`](../../scripts/product-seed-dry-run-report.ts) **wires** slice-4 extractors only for: \`catalog_products\`, \`amazon_amazon_fulfilled_inventory\`, \`amazon_manage_fba_inventory\`, \`amazon_fba_inventory\`. Other tables need new descriptors + tenant scans to join the same classifier rollups.
`;

  fs.writeFileSync(path.join(outDir, "required-column-gap-analysis.md"), gaps, "utf8");

  const importPlan = `# Import pipeline integration plan — NEXT-PRODUCT-ID-18

## Flow

\`\`\`mermaid
flowchart LR
  upload[raw_report_uploads]
  staging[amazon_staging]
  domain[Domain_table]
  laneA[LaneA_resolveAmazonImportProducts]
  laneC[LaneC_ledgerPhase4]
  waveB[LaneB_governed_wave]
  upload --> staging --> domain
  domain --> laneA
  domain --> laneC
  domain --> waveB
\`\`\`

## Sync route responsibilities

[\`app/api/settings/imports/sync/route.ts\`](../../app/api/settings/imports/sync/route.ts) (post-sync block):

| \`AmazonSyncKind\` | Calls \`resolveAmazonImportProducts\` |
|--------------------|----------------------------------------|
| \`ALL_ORDERS\` | \`amazon_all_orders\` |
| \`SETTLEMENT\` | \`amazon_settlements\` |
| \`TRANSACTIONS\` | \`amazon_transactions\` (\`joinAllOrders\` when needed) |
| \`MANAGE_FBA_INVENTORY\` | \`amazon_manage_fba_inventory\` |
| \`AMAZON_FULFILLED_INVENTORY\` | \`amazon_amazon_fulfilled_inventory\` |

**\`INVENTORY_LEDGER\`:** does **not** call the post-sync resolver block; instead runs [\`completeInventoryLedgerProductIdentifierMapPhase\`](../../lib/inventory-ledger-generic-completion.ts) (Lane C).

**\`FBA_INVENTORY\`:** no automatic \`resolveAmazonImportProducts\` in that block; use Lane B waves for \`amazon_fba_inventory\`.

## Rule

Any new \`AmazonSyncKind\` that lands identifier-bearing rows in a table with resolver columns should either:

- register **Lane A** by extending \`ResolveTargetTable\` + sync \`kind\` branch, **or**
- register **Lane B/C** explicitly with governance docs (no silent default).
`;

  fs.writeFileSync(path.join(outDir, "import-pipeline-integration-plan.md"), importPlan, "utf8");

  const apiPlan = `# API ingestion integration plan — NEXT-PRODUCT-ID-18

## Next.js import API

Primary path: [\`app/api/settings/imports/sync/route.ts\`](../../app/api/settings/imports/sync/route.ts) — same resolver hooks as UI-driven imports. **Requirement:** any new HTTP ingestion that inserts into the same domain tables must **reuse** this route’s phases (or extract shared service functions) so Lane A/C behavior is identical.

## Python / Google Sheets

[\`backend-python/main.py\`](../../backend-python/main.py) exposes catalog / Sheets ETL (e.g. \`/etl/sync-google-sheets\` with preview vs apply). **Requirement:** product creation or identifier bridge writes from Sheets must go through the same **dry-run → approval → apply** gates as \`safe_new\` policy; must not bypass \`product_identifier_map\` governance.

## Idempotency

Reuse upload row identity from registry (\`source_line_hash\`, \`source_file_sha256\` + \`source_physical_row_number\`, etc.) so API retries do not duplicate business rows.

## Amazon API

Out of scope for automatic resolution in this pack; raw reports land via the same import engine once downloaded.
`;

  fs.writeFileSync(path.join(outDir, "api-ingestion-integration-plan.md"), apiPlan, "utf8");

  const safeNew = `# Safe-new product creation policy — NEXT-PRODUCT-ID-18

## Classifier

[\`lib/audits/product-seed-classifier.ts\`](../../lib/audits/product-seed-classifier.ts) — **bucket 4** \`safe_new_candidate\`: passes Section E gates (org+store, high-confidence sku/asin/fnsku, no collisions, upload provenance resolved, etc.).

## Policy

1. **Never** auto-create \`products\` rows from import alone.
2. Every bulk or batch create requires a **dry-run pack** (counts, sample PKs, bucket roll-ups) and **explicit signoff**.
3. **UPC-only** and **title-only** paths never auto-create (buckets 6–7).
4. **safe_new** candidates remain **deferred** until PIM / product-creation workflow exists (see NEXT-PRODUCT-ID-17 blocked slice).
5. **Titles** are not merge keys — human or PIM owns canonical naming.

## Operational link

Resolver Lanes A/B only **PATCH** existing product IDs from the bridge; they do **not** create products.
`;

  fs.writeFileSync(path.join(outDir, "safe-new-product-creation-policy.md"), safeNew, "utf8");

  const mapGov = `# product_identifier_map governance — NEXT-PRODUCT-ID-18

## Roles

- **Canonical bridge** between marketplace identifiers and \`products.id\` / \`catalog_product_id\`.
- **Lane A resolver** (\`resolveAmazonImportProducts\`): read-only use of the map; does not INSERT/UPDATE map rows.
- **Lane C ledger enrich** (\`inventory-ledger-identifier-enrich\`): **may INSERT/UPDATE** map rows derived from ledger lines — must be treated as **higher-risk** writes with separate monitoring and rollback playbooks.

## Rules

1. **Soft deletes:** respect \`deleted_at IS NULL\` on map rows when matching.
2. **Store scope:** prefer store-scoped map rows when \`store_id\` is known; org-level rows per existing query patterns in [\`lib/product-identifier-match.ts\`](../../lib/product-identifier-match.ts).
3. **No silent overwrite:** map enrichment updates should be idempotent per upload slice (re-run of same upload should converge, not duplicate business keys — enforced by unique constraints + line hash keys on sources).
4. **Claims:** claim projection trusts \`resolved_product_id\` on source rows when present; map ambiguity surfaces as inbox queues.

## PRODUCT_IDENTITY sync kind

Registry \`PRODUCT_IDENTITY\` sync target is \`product_identifier_map\` — specialized; not the same as Lane A row PATCH on archive tables.
`;

  fs.writeFileSync(path.join(outDir, "product-identifier-map-governance.md"), mapGov, "utf8");

  const idempo = `# Idempotency and lineage rules — NEXT-PRODUCT-ID-18

## Upload lineage

- **Amazon raw imports:** \`raw_report_uploads.id\` linked via \`source_upload_id\` or \`upload_id\` per table (see [\`lib/amazon-import-product-resolver.ts\`](../../lib/amazon-import-product-resolver.ts) \`UPLOAD_ID_COLUMN\`).
- **Physical row identity:** [\`lib/pipeline/amazon-report-registry.ts\`](../../lib/pipeline/amazon-report-registry.ts) defines \`dedupeMode\` and \`conflictColumns\` per kind — e.g. \`source_line_hash\`, \`source_file_sha256\` + \`source_physical_row_number\`.

## Resolver idempotency

- Re-running \`resolveAmazonImportProducts\` for the same upload should converge to the same PATCH values (last write wins with same inputs).
- Ledger Phase 4 records metrics on upload metadata (see [\`lib/inventory-ledger-generic-completion.ts\`](../../lib/inventory-ledger-generic-completion.ts)).

## Claim drafts

[\`claim_candidate_drafts\`](../../supabase/migrations/20260814120000_claim_candidate_drafts.sql): \`idempotency_key\` unique — generator must be stable per source slice.
`;

  fs.writeFileSync(path.join(outDir, "idempotency-and-lineage-rules.md"), idempo, "utf8");

  const rollout = `# Rollout sequence — NEXT-PRODUCT-ID-18

## Phase 1 — Stabilize Lane A (complete)

Ensure post-sync resolver + migrations aligned for: \`amazon_all_orders\`, \`amazon_settlements\`, \`amazon_transactions\`, \`amazon_manage_fba_inventory\`, \`amazon_amazon_fulfilled_inventory\`.

## Phase 2 — Ledger clarity

Document and monitor Lane C vs optional Lane A for \`amazon_inventory_ledger\` (today: Phase 4 dominates; resolver module supports direct PATCH if product wants unified hook).

## Phase 3 — FBA inventory waves

Continue Lane B waves until \`amazon_fba_inventory\` resolver coverage meets policy; keep dry-run + preimage discipline.

## Phase 4 — Returns / removals / reimbursements / reserved

Add resolver columns + extend \`ResolveTargetTable\` **or** explicit alternate resolver services; wire sync \`kind\` branches; extend dry-run descriptors.

## Phase 5 — Claims + drafts

Align \`claim_candidate_drafts\` promotion with resolved source rows; keep operational resolver for removals/returns as guard against broken \`source_row_id\`.

## Phase 6 — Warehouse evidence

Only if required: add \`resolved_product_id\` to \`packages\` / \`slip_contents\` after join strategy exhausted.

## Phase 7 — Multi-channel

Introduce new raw tables + registry entries for Walmart/Shopify when schemas exist; reuse Lane A pattern.
`;

  fs.writeFileSync(path.join(outDir, "rollout-sequence.md"), rollout, "utf8");

  const nextStep = `# Next step recommendation — NEXT-PRODUCT-ID-18

## Recommended next implementation slice

**Extend product-seed dry-run + Lane A together for one high-value gap table** — e.g. \`amazon_inventory_ledger\`:

1. Add a \`SourceTableDescriptor\` in [\`scripts/product-seed-dry-run-report.ts\`](../../scripts/product-seed-dry-run-report.ts) for \`amazon_inventory_ledger\` (extractors may reuse [\`lib/audits/product-seed-identifier-extract.ts\`](../../lib/audits/product-seed-identifier-extract.ts) patterns).
2. Optionally add \`INVENTORY_LEDGER\` post-sync call to \`resolveAmazonImportProducts\` **only if** product owners want Lane A parity with other tables **without** doubling writes against Phase 4 — requires design note to avoid conflicting with Lane C map upserts.

**Alternative (operational):** complete **NEXT-PRODUCT-ID-17C** Wave 1b execution if that is the current business priority — orthogonal to universal coverage but reduces FBA inventory ambiguity immediately.

Pick **one** slice per sprint; do not mix Lane C schema changes with ad-hoc Lane A experiments without a short design note.
`;

  fs.writeFileSync(path.join(outDir, "next-step-recommendation.md"), nextStep, "utf8");

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-18B",
    runId,
    artifactCount: 12,
    matrixRowCount: MATRIX.length,
    biggestCoverageGaps: [
      "amazon_returns / amazon_removals / amazon_removal_shipments / amazon_reimbursements / amazon_reserved_inventory — no resolver writeback columns + no post-sync resolveAmazon hook",
      "product-seed dry-run wired only for 4 slice-4 tables — large blind spot for governance rollups",
      "amazon_inventory_ledger — Lane C vs potential Lane A duplication needs explicit design",
      "Warehouse packages/pallets/slip_contents — product resolution via joins, not unified resolver columns",
    ],
    tablesReadyForResolverWriteback: [
      "amazon_all_orders",
      "amazon_settlements",
      "amazon_transactions",
      "amazon_manage_fba_inventory",
      "amazon_amazon_fulfilled_inventory",
      "amazon_fba_inventory (schema-ready; Lane B)",
      "amazon_inventory_ledger (resolver columns; Phase 4 PATCH)",
      "claim_candidate_drafts",
    ],
    tablesNeedingMigrationsProposed: [
      "amazon_returns",
      "amazon_removals",
      "amazon_removal_shipments",
      "amazon_reserved_inventory",
      "amazon_reimbursements",
      "optional: packages / slip_contents if direct product FK required",
    ],
    tablesNeedingImportWriterOrApiChanges: [
      "app/api/settings/imports/sync/route.ts — new kind → resolveAmazonImportProducts branches",
      "scripts/product-seed-dry-run-report.ts — new SourceTableDescriptor rows",
      "backend-python/main.py — Sheets apply path must call same governance as safe_new",
    ],
    recommendedNextSlice: "Add amazon_inventory_ledger to product-seed-dry-run-report descriptors; design note on Lane A vs Lane C for same upload.",
    validation: {
      noDbWrites: true,
      noMigrations: true,
      noResolverExecution: true,
    },
    sources: [
      "lib/amazon-import-product-resolver.ts",
      "app/api/settings/imports/sync/route.ts",
      "lib/inventory-ledger-generic-completion.ts",
      "lib/inventory-ledger-identifier-enrich.ts",
      "lib/pipeline/amazon-report-registry.ts",
      "scripts/product-seed-dry-run-report.ts",
      "lib/audits/product-seed-classifier.ts",
      "lib/claim-inbox-projection.ts",
      "lib/claim-inbox-schema.ts",
      "lib/claim-operational-source-resolve.ts",
      "supabase/migrations/20260642_amazon_import_file_alignment.sql",
      "supabase/migrations/20260813120000_amazon_fba_inventory_resolver_columns.sql",
      "supabase/migrations/20260814120000_claim_candidate_drafts.sql",
      "backend-python/main.py",
    ],
  };
  writeJson(path.join(outDir, "manifest.json"), manifest);

  log({ event: "complete", runId, manifest });
  console.log(`NEXT-PRODUCT-ID-18 → ${outDir}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
