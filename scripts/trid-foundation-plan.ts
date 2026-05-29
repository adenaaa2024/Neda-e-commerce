/**
 * TRID FOUNDATION PLAN — read-only census + schema/linkage plan (no DB writes).
 *
 *   npx tsx scripts/trid-foundation-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/trid-foundation-plan";
const APPROVAL_REL = ".cursor/operator-approvals/trid-foundation-approval.md";

const TRID_GRAIN_DECISION =
  "layered: (1) operational entity = one discrepancy/claim_line at item or EP-group grain; (2) financial key = reuse financial_reference_resolver.trid_key; (3) filing group = many claim_lines + one selected internal_trid_key per claim_filing_request";

const LIFECYCLE_STATUSES = [
  "detected",
  "evidence_needed",
  "claim_ready",
  "submitted",
  "reimbursed",
  "rejected",
  "closed",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(
    d.getUTCMinutes(),
  )}${p(d.getUTCSeconds())}Z`;
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

async function safeQuery(client: pg.Client, sql: string): Promise<Record<string, unknown>[]> {
  try {
    const r = await client.query(sql);
    return r.rows as Record<string, unknown>[];
  } catch {
    return [];
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

  const tridRelatedTables = [
    "financial_reference_resolver",
    "claim_reference_edges",
    "claim_evidence_lineage_events",
    "claim_enrichment_generations",
    "claim_candidate_drafts",
    "claim_candidates",
    "claim_filing_requests",
    "claim_submissions",
    "claim_review_work_items",
    "claim_review_work_item_events",
    "return_items",
    "expected_packages",
    "amazon_reimbursements",
    "claim_lines",
    "trid_entities",
    "trid_links",
    "trid_events",
  ];

  const schema: Record<string, { exists: boolean; columns: string[]; count: number | null }> = {};
  for (const t of tridRelatedTables) {
    const exists = await tableExists(client, t);
    let count: number | null = null;
    if (exists) {
      const c = await safeQuery(client, `SELECT COUNT(*)::bigint AS c FROM public."${t}"`);
      count = Number(c[0]?.c ?? 0);
    }
    schema[t] = { exists, columns: exists ? await columns(client, t) : [], count };
  }

  const frrCols = schema.financial_reference_resolver.exists
    ? schema.financial_reference_resolver.columns.filter((c) => /trid|order|sku|settlement|source/i.test(c))
    : [];

  const edgeTypes = schema.claim_reference_edges.exists
    ? await safeQuery(
        client,
        `SELECT edge_type, COUNT(*)::int AS c FROM public.claim_reference_edges GROUP BY 1 ORDER BY c DESC`,
      )
    : [];

  const lineageTypes = schema.claim_evidence_lineage_events.exists
    ? await safeQuery(
        client,
        `SELECT event_type, COUNT(*)::int AS c FROM public.claim_evidence_lineage_events GROUP BY 1 ORDER BY c DESC LIMIT 20`,
      )
    : [];

  const draftsNoEdges = schema.claim_candidate_drafts.exists
    ? Number(
        (
          await safeQuery(
            client,
            `SELECT COUNT(*)::bigint AS c FROM public.claim_candidate_drafts d
             WHERE d.resolved_product_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
               AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)`,
          )
        )[0]?.c ?? 0,
      )
    : null;

  const frrDistinctTrid = schema.financial_reference_resolver.exists
    ? Number(
        (
          await safeQuery(
            client,
            `SELECT COUNT(DISTINCT trid_key)::bigint AS c FROM public.financial_reference_resolver WHERE trid_key IS NOT NULL`,
          )
        )[0]?.c ?? 0,
      )
    : null;

  const riLinkage = schema.return_items.exists
    ? (
        await safeQuery(
          client,
          `SELECT
             COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
             COUNT(*) FILTER (WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL)::int AS with_ep,
             COUNT(*) FILTER (WHERE deleted_at IS NULL AND order_id IS NOT NULL)::int AS with_order
           FROM public.return_items`,
        )
      )[0]
    : {};

  await client.end();

  const schemaNeeded = !schema.trid_entities.exists || !schema.trid_links.exists || !schema.claim_lines.exists;
  const reuseFrr = schema.financial_reference_resolver.exists;

  const blockers = [
    "Read-only plan — no DDL/DML",
    !schema.claim_lines.exists
      ? "**No `claim_lines` table** — operational TRID anchor should attach to claim_line, not draft-only"
      : null,
    (draftsNoEdges ?? 0) > 1000
      ? `**${draftsNoEdges}** FK-valid drafts without reference edges — evidence graph thin before TRID lifecycle`
      : null,
    !schema.financial_reference_resolver.exists
      ? "**No `financial_reference_resolver`** on staging — financial TRID substrate missing"
      : null,
    schema.trid_entities.exists
      ? "`trid_entities` already exists — reconcile plan with live DDL before migrate"
      : null,
  ].filter(Boolean) as string[];

  const nextPrompt = !schema.claim_lines.exists
    ? "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-DRYRUN — apply claim_lines before TRID foundation migration"
    : "TRID-FOUNDATION-MIGRATION-DRYRUN — additive trid_entities/trid_links/trid_events on staging";

  fs.writeFileSync(
    path.join(outDir, "trid-grain-decision.md"),
    [
      "# TRID grain decision",
      "",
      "## Canonical decision (layered — not one global grain)",
      "",
      "| Layer | Grain | Identifier | Rationale |",
      "|-------|-------|------------|-----------|",
      "| **Operational** | **One physical discrepancy / claim line** | `trid_entity` (new) | Ties `return_items`, allocated `expected_packages`, scanner evidence, package/pallet context |",
      "| **Operational (group)** | **One root EP + discrepancy_kind** | Same entity, `line_grain=expected_group` | Short/overage before item split; qty on root EP |",
      "| **Financial** | **One settlement/transaction/reimbursement line** | **`financial_reference_resolver.trid_key`** (reuse) | Already built by FRR sync; powers `claim_to_trid` edges today |",
      "| **Filing / reimbursement** | **Many claim_lines → one filing case** | `claim_filing_request` + selected `internal_trid_key` | Amazon reimbursement is case-level; do not force TRID at RI create |",
      "",
      "## Rejected",
      "",
      "- **Per physical item only** — misses EP-group short/over before RI allocation.",
      "- **Per discrepancy only without item FK** — loses damage/wrong-SKU scanner path.",
      "- **Per claim/reimbursement group only** — blocks receive-path work; conflates operational vs financial.",
      "- **New financial TRID table duplicating FRR** — `trid_key` + `claim_reference_edges` already exist.",
      "",
      "## Summary",
      "",
      `\`${TRID_GRAIN_DECISION}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "schema-plan.md"),
    [
      "# Schema plan",
      "",
      "## Existing TRID-related substrate (reuse)",
      "",
      "| Object | Role |",
      "|--------|------|",
      "| **`financial_reference_resolver`** | Financial TRID keys (`trid_key`), order_id/sku/settlement linkage |",
      "| **`claim_reference_edges`** | Persisted graph: `claim_to_trid`, `operational_to_financial`, shipments, removals |",
      "| **`claim_evidence_lineage_events`** | Append-only: `trid_candidate_seen`, `financial_reference_seen` |",
      "| **`claim_enrichment_generations`** | Versioned evidence replay per draft |",
      "| **`claim_review_work_item_events`** | `operator_trid_selection_recorded` audit |",
      "| **`claim_filing_requests.payload.trid`** | Outbound TRID candidate + operator selection (types in `lib/claim-trid-candidates-types.ts`) |",
      "",
      "**No `trid_entities` / `trid_links` / `trid_events` in repo today.** Comment references `v_trid_resolver` view — **not in migrations** (use FRR table directly).",
      "",
      "## Proposed additive schema (when approved)",
      "",
      "### `trid_entities`",
      "",
      "- `id` (uuid PK), `organization_id`, `store_id`",
      "- `entity_kind`: `operational_discrepancy` | `financial_reference` | `filing_group`",
      "- `status`: lifecycle enum (see lifecycle-statuses.md)",
      "- `claim_line_id` (nullable FK → `claim_lines`) — primary operational anchor",
      "- `internal_trid_key` (nullable, mirrors FRR when financial layer attached)",
      "- `primary_product_id`, `primary_order_id`, `primary_sku` (denormalized hints)",
      "- `idempotency_key` (unique per org)",
      "",
      "### `trid_links`",
      "",
      "Polymorphic edges (no graph duplication of `claim_reference_edges` long-term — either materialize from edges or converge):",
      "",
      "- `trid_entity_id`",
      "- `link_role`: `operational_source` | `financial_match` | `evidence` | `filing`",
      "- `target_kind` + `target_id` (uuid/text): `return_items`, `expected_packages`, `claim_candidate_drafts`, `financial_reference_resolver` row, `amazon_reimbursements`, `packages`, `slip_contents`",
      "- `confidence`, `source_table`, `source_row_id`, `metadata` jsonb",
      "",
      "### `trid_events`",
      "",
      "- Append-only lifecycle audit: `trid_entity_id`, `from_status`, `to_status`, `event_type`, `actor`, `payload`",
      "",
      "## Schema needed?",
      "",
      `**${schemaNeeded ? "YES" : "PARTIAL"}** — additive trid_entities + trid_links + trid_events recommended; **reuse FRR** for financial keys; **prerequisite claim_lines**.`,
      "",
      `Financial layer reuse without new table: **${reuseFrr ? "yes" : "no — blocker"}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "linkage-map.md"),
    [
      "# Linkage map",
      "",
      "```mermaid",
      "flowchart TB",
      "  RI[return_items.id]",
      "  EP[expected_packages.id]",
      "  CL[claim_lines.id]",
      "  CD[claim_candidate_drafts.id]",
      "  FRR[financial_reference_resolver.trid_key]",
      "  CRE[claim_reference_edges]",
      "  CFR[claim_filing_requests]",
      "  TE[trid_entities]",
      "  TL[trid_links]",
      "",
      "  RI -->|expected_item_id| EP",
      "  RI --> CL",
      "  EP --> CL",
      "  CL --> TE",
      "  CD --> CRE",
      "  CRE -->|claim_to_trid| FRR",
      "  TE --> TL",
      "  TL --> RI",
      "  TL --> EP",
      "  TL --> FRR",
      "  TE --> CFR",
      "  CL -->|product_id| P[products.id]",
      "  RI -->|tracking order_id package_id| PKG[packages / pallets / slip_contents]",
      "```",
      "",
      "## Relationship table",
      "",
      "| From | To | Join / rule |",
      "|------|-----|-------------|",
      "| `return_items.id` | `expected_packages.id` | `return_items.expected_item_id` (receive_allocated unit) |",
      "| `return_items` | `product_id` | `resolved_product_id` + identifier_map |",
      "| `return_items` | `order_id` / tracking | `order_id`, `package_id` → `packages.tracking_number` |",
      "| `expected_packages.id` | root EP | `source_detail_row_id` / build_source hierarchy |",
      "| **`claim_line.id`** (proposed) | `return_items.id` | FK `return_item_id` (item grain) |",
      "| **`claim_line.id`** (proposed) | `expected_packages.id` | FK `expected_item_id` or `expected_package_root_id` |",
      "| **`claim_line.id`** (proposed) | `product_id` | `resolved_product_id` |",
      "| `claim_candidate_drafts` | operational source | `source_table` + `source_row_id` |",
      "| `claim_reference_edges` | FRR / finances | `edge_type` operational_to_financial / claim_to_trid |",
      "| **`trid_entity`** | FRR | `internal_trid_key` = selected `trid_key` |",
      "| `claim_filing_requests` | TRID payload | `payload.trid` extension (existing) |",
      "| `amazon_reimbursements` | financial | order_id + sku → FRR rows |",
      "",
      "## Staging census (this run)",
      "",
      `- **FRR rows:** ${schema.financial_reference_resolver.count ?? "n/a"}`,
      `- **Distinct trid_key:** ${frrDistinctTrid ?? "n/a"}`,
      `- **claim_reference_edges:** ${schema.claim_reference_edges.count ?? "n/a"}`,
      `- **Drafts FK-valid, no edges:** ${draftsNoEdges ?? "n/a"}`,
      `- **return_items active / with expected_item_id / with order_id:** ${riLinkage.active ?? "?"} / ${riLinkage.with_ep ?? "?"} / ${riLinkage.with_order ?? "?"}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "lifecycle-statuses.md"),
    [
      "# Lifecycle statuses",
      "",
      "## TRID entity lifecycle (proposed enum on `trid_entities.status`)",
      "",
      "| Status | Meaning | Typical triggers |",
      "|--------|---------|------------------|",
      "| **detected** | Discrepancy or candidate surfaced | claim_line / claim_candidate created |",
      "| **evidence_needed** | Missing product link, edges, or ambiguous FRR | unresolved PIM, no edges, ambiguous_multiple TRID outcome |",
      "| **claim_ready** | Operator + resolver satisfied for filing prep | product resolved, TRID selected or single candidate, edges accepted |",
      "| **submitted** | Filing packet / Amazon claim submitted | `claim_filing_requests` / `claim_submissions` |",
      "| **reimbursed** | Financial match confirms reimbursement | `amazon_reimbursements` + FRR linkage |",
      "| **rejected** | Claim rejected or operator rejected evidence | edge `rejected`, submission denied |",
      "| **closed** | Terminal — no further action | work item completed, reimbursed or abandoned |",
      "",
      "## Mapping to existing surfaces",
      "",
      "| Proposed | Today |",
      "|----------|-------|",
      "| detected | `claim_candidates` / draft created |",
      "| evidence_needed | `TridCandidateOutcome` missing_frr / ambiguous; edge `needs_review` |",
      "| claim_ready | operator TRID selected; edges `accepted` |",
      "| submitted | `claim_submissions.status` (workflow) |",
      "| reimbursed | reimbursement reports + FRR |",
      "| rejected | edge review `rejected` |",
      "| closed | `claim_review_work_items` completed |",
      "",
      "## `trid_events`",
      "",
      "Every transition writes append-only event (mirrors `claim_evidence_lineage_events` pattern).",
      "",
      `Allowed values: ${LIFECYCLE_STATUSES.map((s) => `\`${s}\``).join(", ")}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "migration-plan.md"),
    [
      "# Migration plan (proposal only)",
      "",
      "## Prerequisites",
      "",
      "1. **CLAIM-RETURN-LINE-FOUNDATION** — `claim_lines` table on staging",
      "2. **Claim evidence enrichment** — reduce drafts-without-edges cohort (V194 track)",
      "",
      "## Phase T0 — Read models (no new tables)",
      "",
      "- Document FRR `trid_key` as financial layer (this plan)",
      "- View `v_trid_operational_candidates` joining claim_lines + RI + EP (read-only SQL)",
      "",
      "## Phase T1 — Additive TRID foundation tables (staging)",
      "",
      "`supabase/migrations/20260832120000_trid_foundation.sql`",
      "",
      "- `trid_entities`, `trid_links`, `trid_events`",
      "- RLS org-scoped; service_role for governed materializers",
      "",
      "## Phase T2 — Materializer (governed script)",
      "",
      "- Backfill `trid_entities` from existing `claim_reference_edges` + draft anchors",
      "- Link `return_items` / `expected_packages` via claim_line FKs when present",
      "- **Do not** auto-create products",
      "",
      "## Phase T3 — API + AI read path",
      "",
      "- Read API: entity + links + lifecycle for assistant recommendations",
      "- Filing still gated — no blind submit",
      "",
      "## Phase T4 — Optional convergence",
      "",
      "- Evaluate merging duplicate graph (`claim_reference_edges` vs `trid_links`) — defer until volume proven",
      "",
      "## Forbidden",
      "",
      "- Production/original without separate approval",
      "- Amazon API in migration apply",
      "- SKU-only blind repoint",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_REL}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_TRID_FOUNDATION=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.map((b) => `- ${b}`).join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "schema-census.json"),
    JSON.stringify(
      {
        tables: schema,
        frr_trid_columns: frrCols,
        claim_reference_edge_types: edgeTypes,
        lineage_event_types: lineageTypes,
      },
      null,
      2,
    ),
  );

  const manifest = {
    prompt: "TRID FOUNDATION PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    mode: "read_only_plan",
    trid_grain: TRID_GRAIN_DECISION,
    schema_needed: schemaNeeded,
    reuse_financial_reference_resolver: reuseFrr,
    census: {
      financial_reference_resolver_rows: schema.financial_reference_resolver.count,
      distinct_trid_keys: frrDistinctTrid,
      claim_reference_edges: schema.claim_reference_edges.count,
      drafts_fk_valid_no_edges: draftsNoEdges,
      return_items: riLinkage,
      claim_lines_exists: schema.claim_lines.exists,
      trid_entities_exists: schema.trid_entities.exists,
    },
    approval_file: APPROVAL_REL,
    next_prompt: nextPrompt,
    forbidden: { db_writes: true, amazon_api: true, production: true },
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
