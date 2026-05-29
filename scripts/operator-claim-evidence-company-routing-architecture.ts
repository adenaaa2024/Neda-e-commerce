/**
 * OPERATOR CLAIM + EVIDENCE + COMPANY ROUTING ARCHITECTURE — read-only census + docs (no DB writes).
 *
 *   npx tsx scripts/operator-claim-evidence-company-routing-architecture.ts [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/operator-claim-evidence-company-routing-architecture";

const MIGRATION_DRAFT = `-- =============================================================================
-- OPERATOR-CLAIM-CASE-FOUNDATION — additive claim_case + claim_evidence (DRAFT — do not apply)
-- Prerequisite: public.claim_lines (20260831120000)
-- Architecture: operator-claim-evidence-company-routing-architecture dryrun
-- =============================================================================

BEGIN;

-- ── claim_cases: operator workflow container (1 case, many lines, many evidence) ──
CREATE TABLE IF NOT EXISTS public.claim_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  case_number text,
  claim_source text NOT NULL,
  claim_subtype text,
  status text NOT NULL DEFAULT 'open',
  status_reason text,
  priority text NOT NULL DEFAULT 'normal',

  -- Company routing (resolved at create / promote)
  routed_company_key text,
  routed_company_display_name text,

  -- SLA
  sla_policy_id uuid,
  sla_due_at timestamptz,
  sla_breached_at timestamptz,

  -- TRID filing bundle (optional; many lines → one case → one filing request)
  claim_filing_request_id uuid REFERENCES public.claim_filing_requests (id) ON DELETE SET NULL,
  primary_trid_entity_id uuid,

  -- Primary spine pointers (denormalized inbox)
  primary_return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  primary_package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  primary_tracking_number text,
  primary_order_id text,
  primary_sku text,
  primary_resolved_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,

  opened_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,

  CONSTRAINT claim_cases_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT claim_cases_claim_source_chk CHECK (claim_source IN (
    'scanner_operator_issue',
    'expected_mismatch',
    'shipment_discrepancy',
    'delayed_not_received',
    'amazon_reimbursement',
    'warehouse_qc_issue'
  )),
  CONSTRAINT claim_cases_status_chk CHECK (status IN (
    'open',
    'investigating',
    'waiting_amazon',
    'reimbursed',
    'rejected',
    'closed'
  )),
  CONSTRAINT claim_cases_priority_chk CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

COMMENT ON TABLE public.claim_cases IS
  'Operator claim workflow case: groups claim_lines + claim_evidence; company routing + SLA at case grain.';

-- ── claim_lines: add case FK (nullable until promote from detection/backfill) ──
ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS claim_case_id uuid REFERENCES public.claim_cases (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_claim_lines_claim_case
  ON public.claim_lines (claim_case_id)
  WHERE claim_case_id IS NOT NULL;

-- ── claim_evidence: photos, notes, scanner/slip/package/product refs ──
CREATE TABLE IF NOT EXISTS public.claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  claim_case_id uuid NOT NULL REFERENCES public.claim_cases (id) ON DELETE CASCADE,
  claim_line_id uuid REFERENCES public.claim_lines (id) ON DELETE SET NULL,

  evidence_kind text NOT NULL,
  capture_source text NOT NULL DEFAULT 'operator',

  storage_bucket text,
  storage_path text,
  public_url text,
  mime_type text,
  byte_size bigint,
  sha256 text,

  operator_note text,
  scanner_session_id text,
  return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  pallet_id uuid REFERENCES public.pallets (id) ON DELETE SET NULL,
  slip_content_id uuid REFERENCES public.slip_contents (id) ON DELETE SET NULL,
  expected_package_id uuid REFERENCES public.expected_packages (id) ON DELETE SET NULL,
  product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,

  captured_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_evidence_kind_chk CHECK (evidence_kind IN (
    'photo',
    'operator_note',
    'scanner_ref',
    'slip_ref',
    'expected_ref',
    'package_ref',
    'product_ref',
    'document',
    'system_snapshot'
  )),
  CONSTRAINT claim_evidence_capture_source_chk CHECK (capture_source IN (
    'operator',
    'scanner',
    'import',
    'enrichment',
    'amazon_api'
  )),
  CONSTRAINT claim_evidence_media_chk CHECK (
    (evidence_kind IN ('photo', 'document') AND storage_path IS NOT NULL)
    OR evidence_kind NOT IN ('photo', 'document')
  )
);

CREATE INDEX idx_claim_evidence_case
  ON public.claim_evidence (claim_case_id, captured_at DESC);

CREATE INDEX idx_claim_evidence_line
  ON public.claim_evidence (claim_line_id)
  WHERE claim_line_id IS NOT NULL;

-- ── claim_company_routing_rules: which claim types → company entity ──
CREATE TABLE IF NOT EXISTS public.claim_company_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  claim_source text NOT NULL,
  claim_subtype text,
  routed_company_key text NOT NULL,
  routed_company_display_name text,
  marketplace text,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  rule_version text NOT NULL DEFAULT 'ccr.v1',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_company_routing_rules_source_chk CHECK (claim_source IN (
    'scanner_operator_issue',
    'expected_mismatch',
    'shipment_discrepancy',
    'delayed_not_received',
    'amazon_reimbursement',
    'warehouse_qc_issue'
  ))
);

CREATE UNIQUE INDEX uq_claim_company_routing_active
  ON public.claim_company_routing_rules (
    organization_id,
    COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid),
    claim_source,
    COALESCE(claim_subtype, ''),
    routed_company_key
  )
  WHERE is_active = true;

-- ── claim_sla_policies: delayed receipt after X days, etc. ──
CREATE TABLE IF NOT EXISTS public.claim_sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  policy_key text NOT NULL,
  claim_source text NOT NULL,
  trigger_kind text NOT NULL,
  threshold_days integer,
  threshold_hours integer,
  business_calendar text NOT NULL DEFAULT 'calendar',
  escalates_to_status text,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_sla_policies_trigger_chk CHECK (trigger_kind IN (
    'days_since_shipment',
    'days_since_expected_receive',
    'days_since_last_scan',
    'days_in_status'
  ))
);

CREATE UNIQUE INDEX uq_claim_sla_policies_org_key
  ON public.claim_sla_policies (organization_id, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid), policy_key)
  WHERE is_active = true;

-- ── claim_case_events: append-only status / assignment audit ──
CREATE TABLE IF NOT EXISTS public.claim_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  claim_case_id uuid NOT NULL REFERENCES public.claim_cases (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_case_events_type_chk CHECK (event_type IN (
    'case_opened',
    'status_changed',
    'assigned',
    'evidence_added',
    'sla_breached',
    'escalated',
    'trid_linked',
    'case_closed'
  ))
);

CREATE INDEX idx_claim_case_events_case_created
  ON public.claim_case_events (claim_case_id, created_at ASC);

-- RLS (pattern: org-scoped select for authenticated; service_role all)
ALTER TABLE public.claim_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_company_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_case_events ENABLE ROW LEVEL SECURITY;

-- Policies omitted in draft — mirror claim_lines pattern at apply time.

COMMIT;
NOTIFY pgrst, 'reload schema';
`;

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
  const ref = refFromSupabaseUrl(dbUrl);
  let census: Record<string, unknown> = { staging_ref: STAGING_REF, connected: false };
  if (dbUrl && ref === STAGING_REF && getStagingProjectRef({ loadEnv: false }) === STAGING_REF) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const tables = [
      "claim_lines",
      "claim_candidates",
      "claim_evidence_lineage_events",
      "claim_reference_edges",
      "claim_filing_requests",
      "trid_entities",
      "claim_cases",
      "return_items",
      "organization_settings",
    ];
    census.connected = true;
    census.tables = {};
    for (const t of tables) {
      const ex = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name=$1
         ) AS ok`,
        [t],
      );
      const exists = Boolean((ex.rows[0] as { ok: boolean }).ok);
      let count: number | null = null;
      if (exists) {
        const c = await client.query(`SELECT COUNT(*)::int AS c FROM public."${t}"`);
        count = (c.rows[0] as { c: number }).c;
      }
      (census.tables as Record<string, unknown>)[t] = { exists, count };
    }
    await client.end();
  }

  fs.writeFileSync(path.join(outDir, "schema-proposal.sql"), MIGRATION_DRAFT);
  fs.writeFileSync(path.join(outDir, "staging-census.json"), JSON.stringify(census, null, 2));

  fs.writeFileSync(
    path.join(outDir, "schema-proposal.md"),
    [
      "# Schema proposal (dry-run — not applied)",
      "",
      "## Entity model",
      "",
      "```text",
      "claim_case (workflow + routing + SLA + case status)",
      "  ├── claim_lines (existing operational discrepancy rows)",
      "  └── claim_evidence (photos, notes, refs)",
      "claim_company_routing_rules (org/store × claim_source → company)",
      "claim_sla_policies (delayed receipt, status dwell)",
      "claim_case_events (append-only audit)",
      "```",
      "",
      "## New / altered objects",
      "",
      "| Object | Action |",
      "|--------|--------|",
      "| `claim_cases` | **CREATE** |",
      "| `claim_evidence` | **CREATE** |",
      "| `claim_company_routing_rules` | **CREATE** |",
      "| `claim_sla_policies` | **CREATE** |",
      "| `claim_case_events` | **CREATE** |",
      "| `claim_lines.claim_case_id` | **ALTER** nullable FK |",
      "",
      "Proposed migration: `supabase/migrations/20260901120000_claim_case_evidence_foundation.sql`",
      "",
      "Full SQL: `schema-proposal.sql`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "workflow-graph.md"),
    [
      "# Workflow graph",
      "",
      "```mermaid",
      "flowchart TB",
      "  subgraph sources [Claim sources]",
      "    S1[scanner_operator_issue]",
      "    S2[expected_mismatch]",
      "    S3[shipment_discrepancy]",
      "    S4[delayed_not_received]",
      "    S5[amazon_reimbursement]",
      "    S6[warehouse_qc_issue]",
      "  end",
      "",
      "  subgraph detect [Detection layer - existing]",
      "    CC[claim_candidates]",
      "    CL[claim_lines]",
      "  end",
      "",
      "  subgraph ops [Operator workflow - proposed]",
      "    CASE[claim_case]",
      "    EV[claim_evidence]",
      "    RTE[routing_rules]",
      "    SLA[sla_policies]",
      "  end",
      "",
      "  subgraph filing [Filing layer - existing + TRID draft]",
      "    FRR[financial_reference_resolver]",
      "    TE[trid_entities]",
      "    CFR[claim_filing_requests]",
      "  end",
      "",
      "  S1 -->|return_item scan + tags| CL",
      "  S2 -->|v_inventory short/over| CL",
      "  S3 -->|package/tracking delta| CL",
      "  S4 -->|SLA policy breach| CASE",
      "  S5 -->|import candidate / FRR| CL",
      "  S6 -->|QC tags + warehouse context| CL",
      "",
      "  CC -.->|optional bridge| CL",
      "  CL -->|promote / attach| CASE",
      "  CASE --> EV",
      "  RTE -->|resolve company| CASE",
      "  SLA -->|sla_due_at| CASE",
      "",
      "  CASE -->|status lifecycle| CASE",
      "  CL --> TE",
      "  CASE --> CFR",
      "  TE --> FRR",
      "```",
      "",
      "## Case status lifecycle",
      "",
      "| Status | Meaning |",
      "|--------|---------|",
      "| `open` | Case created; evidence may be incomplete |",
      "| `investigating` | Operator actively working |",
      "| `waiting_amazon` | Submitted / awaiting marketplace |",
      "| `reimbursed` | Financial outcome recorded |",
      "| `rejected` | Denied / not pursuable |",
      "| `closed` | Terminal; no further action |",
      "",
      "`claim_lines.status` remains operational (detected → claim_ready → submitted); **case status** is the operator-facing lifecycle.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "routing-rules.md"),
    [
      "# Company routing rules",
      "",
      "## Resolution order",
      "",
      "1. **Store-specific rule** — `(organization_id, store_id, claim_source, claim_subtype)` active row",
      "2. **Org-default rule** — `(organization_id, store_id IS NULL, claim_source)`",
      "3. **Fallback** — `organization_settings.company_display_name` + `metadata.default_claim_company`",
      "",
      "## Source → default company mapping (template)",
      "",
      "| claim_source | Typical routed company | Notes |",
      "|--------------|------------------------|-------|",
      "| `scanner_operator_issue` | Tenant ops / 3PL brand entity | From `organization_settings` |",
      "| `expected_mismatch` | Warehouse receiving entity | Often same org; split by store for multi-brand |",
      "| `shipment_discrepancy` | Carrier claim desk or Amazon inbound | `claim_subtype` = carrier vs FBA |",
      "| `delayed_not_received` | Marketplace claims desk | Amazon SP-API path |",
      "| `amazon_reimbursement` | Finance / reimbursement reconciliation | Links FRR `trid_key` |",
      "| `warehouse_qc_issue` | Internal QC / vendor chargeback | QC team company key |",
      "",
      "## Scanner issue → claim_subtype",
      "",
      "Map `return_items.conditions` / item-unit tags to `claim_subtype`:",
      "",
      "| Scanner tag | claim_subtype |",
      "|-------------|---------------|",
      "| `damaged_product` | `damaged` |",
      "| `scratched` | `scratched` |",
      "| `expired` | `expired` |",
      "| `missing_parts` | `missing_part` |",
      "| `missing_item` | `empty_box` |",
      "| `wrong_item` | `wrong_item` |",
      "| box wizard: `damaged_box` | `damaged_box` |",
      "| box wizard: `empty_box` | `empty_box` |",
      "| (future) `wet` | `wet` |",
      "| (future) `counterfeit_suspect` | `counterfeit_suspect` |",
      "",
      "Box-level issues stay on **package** evidence; item-unit modal tags drive **return_item** lines.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "sla-model.md"),
    [
      "# SLA model",
      "",
      "## Policies (`claim_sla_policies`)",
      "",
      "| policy_key | claim_source | trigger | Default threshold |",
      "|------------|--------------|---------|-------------------|",
      "| `delayed_receive_30d` | `delayed_not_received` | `days_since_expected_receive` | 30 days |",
      "| `delayed_shipment_45d` | `delayed_not_received` | `days_since_shipment` | 45 days |",
      "| `investigating_7d` | `*` (any) | `days_in_status` | 7 days in `investigating` |",
      "",
      "## Case fields",
      "",
      "- `sla_due_at` — computed at case open or status change",
      "- `sla_breached_at` — set by scheduled job when `now() > sla_due_at`",
      "- `claim_case_events.event_type = 'sla_breached'` — audit trail",
      "",
      "## Delayed / not-received detection",
      "",
      "1. Root `expected_packages` with `total_expected > 0` and `total_scanned = 0` beyond threshold",
      "2. Or shipment date + carrier delivery window exceeded (normalization views)",
      "3. Opens **`claim_case`** with `claim_source = delayed_not_received`; attaches existing **`claim_line`** (expected_group short) or creates line + case together",
      "",
      "No auto-submit to Amazon — SLA breach → `waiting_amazon` only after operator action.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "permission-model.md"),
    [
      "# Permission model",
      "",
      "Aligns with [STORE_ACCESS_AND_PERMISSIONS_V1.md](../../docs/claims/STORE_ACCESS_AND_PERMISSIONS_V1.md).",
      "",
      "## Scopes (proposed catalog extensions)",
      "",
      "| Action | Scope | Requires |",
      "|--------|-------|----------|",
      "| `claims.case.view` | store | `user_store_assignments.access_level >= view` |",
      "| `claims.case.create` | store | `access_level >= act` |",
      "| `claims.case.update` | store | `access_level >= act` |",
      "| `claims.case.resolve` | store | `access_level >= act` + role `claims_resolver` |",
      "| `claims.case.escalate` | store | `access_level >= act` |",
      "| `claims.case.close` | store | `access_level >= submit` OR resolver role |",
      "| `claims.evidence.upload` | store | `access_level >= act` |",
      "| `claims.evidence.delete` | store | resolver / admin only |",
      "",
      "## RLS pattern",
      "",
      "- **SELECT**: `organization_id = get_my_organization_id()` AND store in user's active assignments (or tenant admin wildcard)",
      "- **INSERT/UPDATE**: same + server asserts permission catalog",
      "- **claim_case_events**: append-only for authenticated (no UPDATE/DELETE)",
      "",
      "## Who can do what",
      "",
      "| Role | see | create | resolve | escalate |",
      "|------|-----|--------|---------|----------|",
      "| Operator (scanner) | assigned stores | scanner cases + evidence | no | to investigating |",
      "| Claims specialist | assigned stores | all sources | yes | yes |",
      "| Tenant admin | all stores in org | yes | yes | yes |",
      "| Service role | all | governed scripts only | — | — |",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "trid-integration.md"),
    [
      "# TRID integration design",
      "",
      "## Layers (locked from trid-foundation-plan)",
      "",
      "1. **Operational** — `trid_entities` 1:1 `claim_lines` (discrepancy grain)",
      "2. **Financial** — reuse `financial_reference_resolver.trid_key` (no duplicate FRR)",
      "3. **Filing bundle** — `claim_cases.claim_filing_request_id` + optional `primary_trid_entity_id`",
      "",
      "## Wiring",
      "",
      "```text",
      "claim_case",
      "  -> claim_lines (1:N)",
      "  -> trid_entities (1:1 per line at operational layer)",
      "  -> trid_links -> claim_evidence / return_items / expected_packages / FRR rows",
      "  -> claim_filing_request (many lines, one outbound packet)",
      "```",
      "",
      "## Evidence graph",
      "",
      "- **Operator media** → `claim_evidence` (new)",
      "- **Enrichment replay** → `claim_evidence_lineage_events` + `claim_reference_edges` (existing CCE)",
      "- **TRID polymorphic** → `trid_links.link_kind` includes `claim_evidence`, `claim_line`, `return_item`",
      "",
      "## Promotion flow",
      "",
      "1. Scanner save → `return_items` + `claim_evidence` photos",
      "2. Promote → `claim_line` (return_item grain) + `claim_case` (scanner_operator_issue)",
      "3. On filing readiness → `trid_entity` + FRR selection + `claim_filing_request`",
      "",
      "Do **not** create TRID rows during schema-only migrations.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "evidence-storage-design.md"),
    [
      "# Evidence / media storage design",
      "",
      "## Storage layout (Supabase `media` bucket)",
      "",
      "```text",
      "{organization_id}/claim-cases/{claim_case_id}/evidence/{evidence_id}/{filename}",
      "{organization_id}/claim-cases/{claim_case_id}/lines/{claim_line_id}/evidence/{evidence_id}/{filename}",
      "```",
      "",
      "## Row contract (`claim_evidence`)",
      "",
      "| Field | Use |",
      "|-------|-----|",
      "| `evidence_kind` | photo, operator_note, scanner_ref, … |",
      "| `storage_bucket` | `media` |",
      "| `storage_path` | object key above |",
      "| `sha256` | dedupe / integrity |",
      "| `return_item_id` / `package_id` / … | spine FKs |",
      "| `operator_note` | text evidence (kind=operator_note) |",
      "",
      "## Scanner today",
      "",
      "- Item unit modal uploads via `uploadMediaFileAction` → persist URL on save payload",
      "- **Target**: write `claim_evidence` row + storage path; mirror URL in `return_items` metadata only during transition",
      "",
      "## Security",
      "",
      "- Private bucket; signed URLs for UI",
      "- RLS on `claim_evidence` matches case org/store",
      "- Classification: `claim_evidence` per storage-inventory-report.ts",
      "",
      "## Complements (not replaces)",
      "",
      "- `claim_reference_edges` — graph enrichment",
      "- `claim_evidence_lineage_events` — replay audit",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "claim-source-matrix.md"),
    [
      "# Claim source matrix",
      "",
      "| # | Source | Detection → line | Case opener | Evidence required |",
      "|---|--------|------------------|-------------|-------------------|",
      "| 1 | Scanner/operator issue | `return_item` grain from scan | Operator or auto-promote | Photos if non-OK tags |",
      "| 2 | Expected mismatch | `expected_group` short/over | Batch or operator | Inventory snapshot |",
      "| 3 | Shipment discrepancy | EP root + tracking/slip | Operator | Package photos, BOL |",
      "| 4 | Delayed/not-received | SLA job → new case | System + operator | Tracking timeline |",
      "| 5 | Amazon reimbursement | `import_source` / FRR | Import + finance | SP-API / report refs |",
      "| 6 | Warehouse QC | scanner tags + QC flag | QC lead | QC checklist photos |",
    ].join("\n") + "\n",
  );

  const nextPrompt =
    "CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-DRYRUN — dry-run claim_cases + claim_evidence migration on staging";

  const manifest = {
    prompt: "OPERATOR-CLAIM-EVIDENCE-COMPANY-ROUTING-ARCHITECTURE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    staging_census: census,
    proposed_migration: "supabase/migrations/20260901120000_claim_case_evidence_foundation.sql",
    prerequisites: ["claim_lines APPLIED", "TRID foundation optional after case schema"],
    next_migration_prompt: nextPrompt,
    artifacts: [
      "schema-proposal.md",
      "schema-proposal.sql",
      "workflow-graph.md",
      "routing-rules.md",
      "sla-model.md",
      "permission-model.md",
      "trid-integration.md",
      "evidence-storage-design.md",
      "claim-source-matrix.md",
      "staging-census.json",
      "manifest.json",
    ],
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
