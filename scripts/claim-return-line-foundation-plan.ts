/**
 * CLAIM / RETURN LINE FOUNDATION PLAN — read-only census + docs.
 *
 *   npx tsx scripts/claim-return-line-foundation-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-foundation-plan";
const APPROVAL_REL = ".cursor/operator-approvals/claim-return-line-foundation-approval.md";

const CLAIM_LINE_GRAIN =
  "hybrid: item-grain for scanner/receive (1 claim_line ↔ 1 return_items); group-grain for expected-vs-scanned short/overage on root EP; import-grain for removal/reimbursement candidates until TRID grouping";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function columns(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function safeCount(client: pg.Client, sql: string): Promise<number | null> {
  try {
    const r = await client.query(sql);
    return Number(r.rows[0]?.c ?? 0);
  } catch {
    return null;
  }
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
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const inspectTables = [
    "claims",
    "claim_candidates",
    "claim_candidate_drafts",
    "claim_submissions",
    "claim_reference_edges",
    "claim_enrichment_generations",
    "claim_evidence_lineage_events",
    "claim_filing_requests",
    "claim_review_work_items",
    "return_items",
    "expected_packages",
    "amazon_removals",
    "amazon_removal_shipments",
    "slip_contents",
    "packages",
    "pallets",
  ];

  const schema: Record<string, { exists: boolean; columns: string[]; count: number | null }> = {};
  for (const t of inspectTables) {
    const exists = await tableExists(client, t);
    schema[t] = {
      exists,
      columns: exists ? await columns(client, t) : [],
      count: exists
        ? await safeCount(client, `SELECT COUNT(*)::bigint AS c FROM public."${t}"`)
        : null,
    };
  }

  const ccSource = schema.claim_candidates.exists
    ? await client.query(`
        SELECT source_table, COUNT(*)::int AS c
        FROM public.claim_candidates
        GROUP BY source_table ORDER BY c DESC
      `)
    : { rows: [] };

  const cdSource = schema.claim_candidate_drafts.exists
    ? await client.query(`
        SELECT source_table, COUNT(*)::int AS c
        FROM public.claim_candidate_drafts
        GROUP BY source_table ORDER BY c DESC
      `)
    : { rows: [] };

  const riExpectedItem = schema.return_items.exists
    ? await client.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL)::int AS with_expected_item_id,
          COUNT(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS resolved
        FROM public.return_items
      `)
    : { rows: [{}] };

  const epBuild = schema.expected_packages.exists
    ? await client.query(`
        SELECT COALESCE(build_source, '(null)') AS build_source, COUNT(*)::int AS c
        FROM public.expected_packages
        GROUP BY 1 ORDER BY c DESC
      `)
    : { rows: [] };

  const epReceiveAllocated = schema.expected_packages.exists
    ? await safeCount(
        client,
        `SELECT COUNT(*)::bigint AS c FROM public.expected_packages WHERE build_source='receive_allocated'`,
      )
    : null;

  const joinRiEp = schema.return_items.exists
    ? await client.query(`
        SELECT COUNT(*)::int AS c
        FROM public.return_items ri
        INNER JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
        WHERE ri.deleted_at IS NULL
      `)
    : { rows: [{ c: 0 }] };

  const candidatesReturnItems = schema.claim_candidates.exists
    ? await safeCount(
        client,
        `SELECT COUNT(*)::bigint AS c FROM public.claim_candidates
         WHERE source_table IN ('return_items', 'returns')`,
      )
    : null;

  const edgesCount = schema.claim_reference_edges.exists
    ? await client.query(`
        SELECT edge_type, COUNT(*)::int AS c
        FROM public.claim_reference_edges
        GROUP BY edge_type ORDER BY c DESC
      `)
    : { rows: [] };

  await client.end();

  const ri = riExpectedItem.rows[0] as Record<string, number>;
  const schemaNeeded = true; // no claim_lines table today

  fs.writeFileSync(
    path.join(outDir, "claim-line-grain-decision.md"),
    [
      "# Claim line grain decision",
      "",
      "## Decision (canonical)",
      "",
      "**Hybrid grain** — pick grain by discrepancy lane, not one global rule:",
      "",
      "| Lane | Grain | Rationale |",
      "|------|-------|-----------|",
      "| **Scanner / receive** | **1 claim_line ↔ 1 `return_items` row** | Item-level receive model: one physical unit per RI; `expected_item_id` points at allocated EP unit |",
      "| **Expected vs scanned (short/overage)** | **1 claim_line ↔ 1 root `expected_packages` + discrepancy_kind** | Group qty lives on EP; short/over before item attribution uses root EP + scope |",
      "| **Removal / import candidates** | **1 claim_line ↔ 1 candidate source row** (initially) | Today `claim_candidates` grain = `source_table` + `source_row_id`; split to item grain only when receive linkage exists |",
      "| **TRID / reimbursement (later)** | **Many claim_lines → 1 TRID / filing group** | Financial lifecycle groups operational lines; do not force TRID at line create |",
      "",
      "## Rejected alternatives",
      "",
      "- **One claim line per discrepancy group only** — loses item-level damage/wrong-SKU evidence from scanner.",
      "- **One claim line per TRID from day one** — TRID not wired; blocks receive-path claims.",
      "- **Reuse `claim_candidates` as claim_line** — wrong lifecycle (detection queue ≠ filed operational line); no stable RI/EP FKs.",
      "",
      "## Summary string",
      "",
      `\`${CLAIM_LINE_GRAIN}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "schema-gap-report.md"),
    [
      "# Schema gap report",
      "",
      "## Inspected objects (staging live)",
      "",
      "| Table | Exists | Rows | Key linkage columns |",
      "|-------|--------|-----:|---------------------|",
      ...inspectTables.map((t) => {
        const s = schema[t]!;
        const linkCols = s.columns.filter((c) =>
          /product|expected|return|source|package|pallet|slip|tracking|order|resolved/i.test(c),
        );
        return `| \`${t}\` | ${s.exists} | ${s.count ?? "n/a"} | ${linkCols.slice(0, 8).join(", ") || "—"} |`;
      }),
      "",
      "## Gaps",
      "",
      "| Gap | Severity |",
      "|-----|----------|",
      "| No `claims` or **`claim_lines`** table | **Blocker** for operational traceability |",
      "| `claim_submissions.return_id` → legacy whole-return grain (1:1) | High — predates item-level receive |",
      "| `claim_candidates` / drafts: `source_table` + `source_row_id` only — no `return_item_id` / `expected_item_id` FK | High |",
      "| `claim_reference_edges`: graph edges, not operational claim lines | Medium — enrichment layer only |",
      "| `return_items.expected_item_id` present (migration) — staging linkage coverage see census | Medium |",
      "",
      "## Staging census snippets",
      "",
      `- **return_items** active: **${ri.active ?? "n/a"}**; with \`expected_item_id\`: **${ri.with_expected_item_id ?? "n/a"}**; resolved: **${ri.resolved ?? "n/a"}**`,
      `- **expected_packages** \`receive_allocated\`: **${epReceiveAllocated ?? "n/a"}**`,
      `- **RI ↔ EP join** on \`expected_item_id\`: **${(joinRiEp.rows[0] as { c: number }).c}**`,
      `- **claim_candidates** with source \`return_items\`/\`returns\`: **${candidatesReturnItems ?? "n/a"}**`,
      "",
      "**Schema migration needed:** **yes** — additive `claim_lines` (+ optional `claim_line_groups` for TRID later).",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "linkage-contract.md"),
    [
      "# Linkage contract — claim_line ↔ operational spine",
      "",
      "## Required FKs / pointers on `claim_lines` (proposed)",
      "",
      "| Field | Target | Required when |",
      "|-------|--------|---------------|",
      "| `return_item_id` | `return_items.id` | Scanner/receive lane |",
      "| `expected_item_id` | `expected_packages.id` (`receive_allocated` or root) | When RI allocated |",
      "| `expected_package_root_id` | Root EP (`detail_*` / `legacy`) | Group short/over lane |",
      "| `resolved_product_id` | `products.id` | When product known (resolver) |",
      "| `package_id` | `packages.id` | Slip/package context |",
      "| `pallet_id` | `pallets.id` | Pallet context |",
      "| `id_slip_contents` / slip FK | slip line | When discrepancy from slip |",
      "| `source_detail_row_id` | `amazon_removals.id` | Removal lineage |",
      "| `source_shipment_row_id` | `amazon_removal_shipments.id` | Shipment lineage |",
      "| `claim_candidate_id` | `claim_candidates.id` | Optional back-link from detection |",
      "| `claim_candidate_draft_id` | `claim_candidate_drafts.id` | V2 generator staging |",
      "",
      "## Read contract (display)",
      "",
      "Use **`ProductLinkageDisplayContract`** for product column — same as returns/scanner.",
      "",
      "## Trace chain (target)",
      "",
      "```text",
      "amazon_removals / amazon_removal_shipments",
      "  → expected_packages (detail_shipment | detail_remainder | receive_allocated)",
      "  → return_items (1 physical item, expected_item_id)",
      "  → claim_line (discrepancy + evidence)",
      "  → claim_candidate_draft → filing → TRID (later)",
      "```",
      "",
      "## Constraints",
      "",
      "- No auto product create from claim_line",
      "- No `package_items`",
      "- Do not query legacy `returns` for line data",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "discrepancy-source-map.md"),
    [
      "# Discrepancy source map",
      "",
      "| Discrepancy | Detection source | Primary grain | Proposed claim_line fields |",
      "|-------------|------------------|---------------|----------------------------|",
      "| Expected vs scanned **short** | `v_inventory_item_status` / EP `expected_scan_quantity` vs `COUNT(return_items)` | Root EP + scope | `expected_package_root_id`, `discrepancy_kind=short`, `quantity_delta` |",
      "| **Overage / unexpected** | Receive allocate `overage_only`; EP remainder < 0 | Root EP or RI | `discrepancy_kind=overage`, optional `return_item_id` |",
      "| **Damage / disposition** | `return_items.conditions`, photos | **return_items** | `return_item_id`, `discrepancy_kind=damage` |",
      "| **Missing product link** | Resolver `identifier_resolution_status` unresolved/ambiguous | **return_items** or candidate | `return_item_id` or candidate source, `discrepancy_kind=missing_product_link` |",
      "| **Removal disposed / not reimbursed** | `v_claim_base_amazon_removals`, claim_candidates | Source row | `source_detail_row_id`, Amazon financial edges |",
      "| **Package count mismatch** | `packages.expected_item_count` vs actual | Package aggregate | `package_id`, group grain |",
      "",
      "## claim_candidates source_table (staging)",
      "",
      ...ccSource.rows.map(
        (r: { source_table: string; c: number }) => `- \`${r.source_table}\`: **${r.c}**`,
      ),
      "",
      "## claim_candidate_drafts source_table (staging)",
      "",
      ...cdSource.rows.map(
        (r: { source_table: string; c: number }) => `- \`${r.source_table}\`: **${r.c}**`,
      ),
      "",
      "## expected_packages build_source (staging)",
      "",
      ...epBuild.rows.map(
        (r: { build_source: string; c: number }) => `- \`${r.build_source}\`: **${r.c}**`,
      ),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "migration-plan.md"),
    [
      "# Migration plan (proposal only — do not apply in this prompt)",
      "",
      "## Phase A — Additive schema (staging first)",
      "",
      "1. **`claim_lines`** table",
      "   - `id`, `organization_id`, `store_id`",
      "   - `line_grain` enum: `item` | `expected_group` | `import_source`",
      "   - `discrepancy_kind` enum: `short`, `overage`, `damage`, `missing_product_link`, `removal_financial`, `other`",
      "   - FKs: `return_item_id`, `expected_item_id`, `expected_package_root_id`, `resolved_product_id`, `package_id`, `pallet_id`",
      "   - Lineage: `source_detail_row_id`, `source_shipment_row_id`",
      "   - Bridge: `claim_candidate_id`, `claim_candidate_draft_id` (nullable)",
      "   - `quantity_delta`, `status`, `idempotency_key`, audit timestamps",
      "   - RLS org-scoped; service_role for governed scripts",
      "",
      "2. **`claim_line_evidence`** (optional phase A.5) — photos, operator notes, edge refs",
      "",
      "3. **Views** — `v_claim_lines_operational` joining RI/EP/product display contract",
      "",
      "## Phase B — Backfill / generator (separate approval)",
      "",
      "- Materialize claim_lines from existing `claim_candidates` where source is `return_items` / `amazon_removal_shipments`",
      "- Do **not** auto-backfill from fuzzy title/OCR",
      "",
      "## Phase C — Filing bridge",
      "",
      "- Extend `claim_filing_requests` to reference `claim_line_id`(s) instead of only draft",
      "- TRID grouping table when reimbursement lifecycle prompt lands",
      "",
      "## Phase D — Deprecate paths",
      "",
      "- Keep `claim_candidates` as **detection inbox**; promote to `claim_lines` explicitly",
      "- Migrate `claim_submissions.return_id` to `claim_line_id` over time (nullable dual-write period)",
      "",
      "## Migration file naming (when approved)",
      "",
      "`supabase/migrations/20260831120000_claim_lines_foundation.sql`",
    ].join("\n") + "\n",
  );

  const approvalContent = `# Claim / return line foundation — operator approval

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Branch | \`feature/product-canonicalization-v2\` |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_CLAIM_RETURN_LINE_FOUNDATION=false
\`\`\`

## Scope (when approved)

1. Apply additive \`claim_lines\` migration on staging
2. Read-only backfill dry-run from claim_candidates + return_items/EP joins
3. No production / original without separate approval

## Forbidden

- Product auto-create
- Bulk claim submit
- Amazon API in schema apply

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_CLAIM_RETURN_LINE_FOUNDATION=false
Approved by:
UTC date:
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), APPROVAL_REL), approvalContent);

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_REL}\``,
      "",
      "Defaults:",
      "- `APPROVED_TO_RUN_STAGING=false`",
      "- `APPROVED_CLAIM_RETURN_LINE_FOUNDATION=false`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only plan — no DDL/DML in this run",
      "- **No `claim_lines` table** — operational traceability not persisted",
      "- Item-level receive split repair may be pending on staging (see SCANNER_STATE.md)",
      `- RI with \`expected_item_id\`: **${ri.with_expected_item_id ?? "?"}** / **${ri.active ?? "?"}** active — backfill quality depends on receive repair`,
      "- Claim filing still draft-centric (`claim_candidate_drafts`) — not line-centric",
      "- TRID lifecycle explicitly deferred",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-FOUNDATION-PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    mode: "read_only",
    status: "PASS",
    claim_line_grain: CLAIM_LINE_GRAIN,
    schema_migration_needed: schemaNeeded,
    census: {
      return_items: ri,
      expected_packages_receive_allocated: epReceiveAllocated,
      ri_ep_join: (joinRiEp.rows[0] as { c: number }).c,
      claim_candidates_by_source: ccSource.rows,
      claim_drafts_by_source: cdSource.rows,
      claim_reference_edges_by_type: edgesCount.rows,
    },
    approval_file: APPROVAL_REL,
    next_prompt: "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-DRY-RUN",
    forbidden: { db_writes: true, amazon_api: true, product_create: true },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "schema-census.json"), JSON.stringify(schema, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
