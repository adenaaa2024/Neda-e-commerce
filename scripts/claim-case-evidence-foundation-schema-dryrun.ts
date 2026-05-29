/**
 * CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-DRYRUN — migration draft + staging census (read-only).
 *
 *   npx tsx scripts/claim-case-evidence-foundation-schema-dryrun.ts [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/claim-case-evidence-foundation-schema-dryrun";
const APPROVAL_REL = ".cursor/operator-approvals/claim-case-evidence-foundation-schema-approval.md";
const ARCH_REF =
  ".cursor/audit-reports/operator-claim-evidence-company-routing-architecture/20260601T140000Z";
const MIGRATION_FILENAME = "20260901120000_claim_case_evidence_foundation.sql";

const SCANNER_ISSUE_TYPES = [
  "damaged_product",
  "scratched",
  "expired",
  "missing_parts",
  "wrong_item",
  "empty_box",
  "damaged_box",
  "wet",
  "counterfeit_suspect",
  "operator_other",
] as const;

const SCANNER_ISSUE_SQL_LIST = SCANNER_ISSUE_TYPES.map((t) => `'${t}'`).join(", ");

const MIGRATION_DRAFT = `-- =============================================================================
-- CLAIM-CASE-EVIDENCE-FOUNDATION — additive case/evidence/routing/SLA (DRAFT — do not apply)
-- Prerequisite: public.claim_lines (20260831120000)
-- Dry-run: claim-case-evidence-foundation-schema-dryrun
-- =============================================================================

BEGIN;

-- ── claim_cases ──
CREATE TABLE IF NOT EXISTS public.claim_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  case_number text,
  claim_source text NOT NULL,
  claim_subtype text,
  scanner_issue_type text,
  status text NOT NULL DEFAULT 'open',
  status_reason text,
  priority text NOT NULL DEFAULT 'normal',

  routed_company_key text,
  routed_company_display_name text,

  sla_rule_id uuid,
  sla_due_at timestamptz,
  sla_breached_at timestamptz,

  claim_filing_request_id uuid REFERENCES public.claim_filing_requests (id) ON DELETE SET NULL,

  primary_return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  primary_package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  primary_claim_line_id uuid REFERENCES public.claim_lines (id) ON DELETE SET NULL,
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
  CONSTRAINT claim_cases_scanner_issue_type_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN (${SCANNER_ISSUE_SQL_LIST})
  ),
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
  'Operator claim case: workflow container for claim_lines + claim_evidence. Scanner issues use scanner_issue_type + claim_source=scanner_operator_issue.';

COMMENT ON COLUMN public.claim_cases.scanner_issue_type IS
  'Canonical scanner defect tag when claim_source=scanner_operator_issue; mirrors return_items.conditions / item-unit modal.';

CREATE INDEX idx_claim_cases_org_store_status
  ON public.claim_cases (organization_id, store_id, status);

CREATE INDEX idx_claim_cases_org_scanner_issue
  ON public.claim_cases (organization_id, scanner_issue_type)
  WHERE scanner_issue_type IS NOT NULL;

-- ── claim_lines: case FK + scanner issue on item-grain lines ──
ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS claim_case_id uuid REFERENCES public.claim_cases (id) ON DELETE SET NULL;

ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS scanner_issue_type text;

ALTER TABLE public.claim_lines
  DROP CONSTRAINT IF EXISTS claim_lines_scanner_issue_type_chk;

ALTER TABLE public.claim_lines
  ADD CONSTRAINT claim_lines_scanner_issue_type_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN (${SCANNER_ISSUE_SQL_LIST})
  );

CREATE INDEX IF NOT EXISTS idx_claim_lines_claim_case
  ON public.claim_lines (claim_case_id)
  WHERE claim_case_id IS NOT NULL;

-- ── claim_evidence ──
CREATE TABLE IF NOT EXISTS public.claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  claim_case_id uuid NOT NULL REFERENCES public.claim_cases (id) ON DELETE CASCADE,
  claim_line_id uuid REFERENCES public.claim_lines (id) ON DELETE SET NULL,

  evidence_kind text NOT NULL,
  capture_source text NOT NULL DEFAULT 'operator',
  scanner_issue_type text,

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
  CONSTRAINT claim_evidence_scanner_issue_type_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN (${SCANNER_ISSUE_SQL_LIST})
  ),
  CONSTRAINT claim_evidence_media_chk CHECK (
    (evidence_kind IN ('photo', 'document') AND (storage_path IS NOT NULL OR public_url IS NOT NULL))
    OR evidence_kind NOT IN ('photo', 'document')
  )
);

COMMENT ON TABLE public.claim_evidence IS
  'Case evidence: photos, operator notes, scanner/slip/package/product refs. Photos from scanner attach here + optional legacy URL on return_items during transition.';

CREATE INDEX idx_claim_evidence_case_captured
  ON public.claim_evidence (claim_case_id, captured_at DESC);

CREATE INDEX idx_claim_evidence_return_item
  ON public.claim_evidence (return_item_id)
  WHERE return_item_id IS NOT NULL;

-- ── claim_company_routing_rules ──
CREATE TABLE IF NOT EXISTS public.claim_company_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  claim_source text NOT NULL,
  claim_subtype text,
  scanner_issue_type text,
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
  )),
  CONSTRAINT claim_company_routing_rules_scanner_issue_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN (${SCANNER_ISSUE_SQL_LIST})
  )
);

CREATE UNIQUE INDEX uq_claim_company_routing_active
  ON public.claim_company_routing_rules (
    organization_id,
    COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid),
    claim_source,
    COALESCE(claim_subtype, ''),
    COALESCE(scanner_issue_type, ''),
    routed_company_key
  )
  WHERE is_active = true;

-- ── claim_sla_rules (settings-driven thresholds; org_settings fallback) ──
CREATE TABLE IF NOT EXISTS public.claim_sla_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  rule_key text NOT NULL,
  claim_source text NOT NULL,
  trigger_kind text NOT NULL,
  threshold_days integer,
  threshold_hours integer,
  business_calendar text NOT NULL DEFAULT 'calendar',
  escalates_to_status text,
  settings_path text,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_sla_rules_trigger_chk CHECK (trigger_kind IN (
    'days_since_shipment',
    'days_since_expected_receive',
    'days_since_last_scan',
    'days_in_status'
  )),
  CONSTRAINT claim_sla_rules_source_chk CHECK (claim_source IN (
    'scanner_operator_issue',
    'expected_mismatch',
    'shipment_discrepancy',
    'delayed_not_received',
    'amazon_reimbursement',
    'warehouse_qc_issue'
  ))
);

COMMENT ON COLUMN public.claim_sla_rules.settings_path IS
  'JSON path into organization_settings.metadata or default_claim_evidence for threshold override, e.g. delayed_not_received_days.';

CREATE UNIQUE INDEX uq_claim_sla_rules_org_key
  ON public.claim_sla_rules (organization_id, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_key)
  WHERE is_active = true;

-- ── claim_case_events (append-only) ──
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

-- FK claim_cases.sla_rule_id after claim_sla_rules exists
ALTER TABLE public.claim_cases
  DROP CONSTRAINT IF EXISTS claim_cases_sla_rule_id_fkey;

ALTER TABLE public.claim_cases
  ADD CONSTRAINT claim_cases_sla_rule_id_fkey
  FOREIGN KEY (sla_rule_id) REFERENCES public.claim_sla_rules (id) ON DELETE SET NULL;

-- ── RLS + permissions (catalog enforced in app; policies mirror claim_lines) ──
ALTER TABLE public.claim_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_company_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_sla_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_case_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_cases_service_role_all" ON public.claim_cases;
CREATE POLICY "claim_cases_service_role_all"
  ON public.claim_cases FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_cases_select_own_org" ON public.claim_cases;
CREATE POLICY "claim_cases_select_own_org"
  ON public.claim_cases FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_evidence_service_role_all" ON public.claim_evidence;
CREATE POLICY "claim_evidence_service_role_all"
  ON public.claim_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_evidence_select_own_org" ON public.claim_evidence;
CREATE POLICY "claim_evidence_select_own_org"
  ON public.claim_evidence FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_company_routing_rules_service_role_all" ON public.claim_company_routing_rules;
CREATE POLICY "claim_company_routing_rules_service_role_all"
  ON public.claim_company_routing_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_company_routing_rules_select_own_org" ON public.claim_company_routing_rules;
CREATE POLICY "claim_company_routing_rules_select_own_org"
  ON public.claim_company_routing_rules FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_sla_rules_service_role_all" ON public.claim_sla_rules;
CREATE POLICY "claim_sla_rules_service_role_all"
  ON public.claim_sla_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_sla_rules_select_own_org" ON public.claim_sla_rules;
CREATE POLICY "claim_sla_rules_select_own_org"
  ON public.claim_sla_rules FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_case_events_service_role_all" ON public.claim_case_events;
CREATE POLICY "claim_case_events_service_role_all"
  ON public.claim_case_events FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_case_events_select_own_org" ON public.claim_case_events;
CREATE POLICY "claim_case_events_select_own_org"
  ON public.claim_case_events FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_cases TO service_role;
GRANT SELECT ON public.claim_cases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_evidence TO service_role;
GRANT SELECT ON public.claim_evidence TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_company_routing_rules TO service_role;
GRANT SELECT ON public.claim_company_routing_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_sla_rules TO service_role;
GRANT SELECT ON public.claim_sla_rules TO authenticated;
GRANT SELECT, INSERT ON public.claim_case_events TO service_role;
GRANT SELECT ON public.claim_case_events TO authenticated;

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

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, col],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch must be ${REQUIRED_BRANCH} (got ${branch})`);
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromSupabaseUrl(dbUrl);
  const census: Record<string, unknown> = { staging_ref: STAGING_REF, connected: false };

  if (dbUrl && ref === STAGING_REF && getStagingProjectRef({ loadEnv: false }) === STAGING_REF) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    census.connected = true;

    const tables = [
      "claim_lines",
      "claim_cases",
      "claim_evidence",
      "claim_company_routing_rules",
      "claim_sla_rules",
      "return_items",
      "organization_settings",
    ];
    census.tables = {};
    for (const t of tables) {
      const ex = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1
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

    const claimLinesExists = (census.tables as Record<string, { exists: boolean }>).claim_lines?.exists;
    if (!claimLinesExists) {
      blockers.push("Prerequisite: public.claim_lines must exist before case schema apply");
    } else {
      census.claim_lines_has_claim_case_id = await columnExists(client, "claim_lines", "claim_case_id");
      if (census.claim_lines_has_claim_case_id) {
        blockers.push("claim_lines.claim_case_id already exists — reconcile migration");
      }
    }

    if ((census.tables as Record<string, { exists: boolean }>).claim_cases?.exists) {
      blockers.push("claim_cases already exists on staging");
    }

    const riTags = await client.query(`
      SELECT unnest(conditions) AS tag, COUNT(*)::int AS c
      FROM public.return_items
      WHERE deleted_at IS NULL AND conditions IS NOT NULL
      GROUP BY 1 ORDER BY c DESC LIMIT 15
    `).catch(() => ({ rows: [] }));
    census.return_items_condition_tags = riTags.rows;

    await client.end();
  } else {
    blockers.push("Staging DB not connected — census partial");
  }

  fs.writeFileSync(path.join(outDir, "claim-case-evidence-migration-draft.sql"), MIGRATION_DRAFT);
  fs.writeFileSync(
    path.join(outDir, "schema-proposal.md"),
    [
      "# Schema proposal (dry-run — not applied)",
      "",
      "## Objects",
      "",
      "| # | Object | Action |",
      "|---|--------|--------|",
      "| 1 | `claim_cases` | CREATE |",
      "| 2 | `claim_evidence` | CREATE |",
      "| 3 | `claim_company_routing_rules` | CREATE |",
      "| 4 | `claim_sla_rules` | CREATE |",
      "| 5 | `claim_lines.claim_case_id` | ALTER ADD nullable FK |",
      "| 6 | `claim_lines.scanner_issue_type` | ALTER ADD |",
      "| 7 | `claim_case_events` | CREATE (audit) |",
      "| 8 | RLS policies | CREATE per table |",
      "",
      "**Migration file:** `supabase/migrations/${MIGRATION_FILENAME}`",
      "",
      "## Scanner issue types (CHECK)",
      "",
      SCANNER_ISSUE_TYPES.map((t) => `- \`${t}\``).join("\n"),
      "",
      `Architecture ref: \`${ARCH_REF}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "scanner-attachment-flow.md"),
    [
      "# Scanner issue → claim_line / claim_case / evidence",
      "",
      "## Flow (operator mobile save)",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  participant Op as Operator",
      "  participant Scan as Scanner page",
      "  participant RI as return_items",
      "  participant CE as claim_evidence",
      "  participant CL as claim_lines",
      "  participant CC as claim_cases",
      "",
      "  Op->>Scan: Select issue chips + photos",
      "  Scan->>RI: INSERT/UPDATE conditions[], notes, package_id",
      "  Scan->>CE: INSERT photo rows (evidence_kind=photo, capture_source=scanner)",
      "  Note over CE: storage_path in media bucket",
      "  Scan->>CL: UPSERT return_item grain line (idempotency cl:return_item:org:ri)",
      "  Scan->>CC: INSERT case (claim_source=scanner_operator_issue, scanner_issue_type=tag)",
      "  Scan->>CL: UPDATE claim_case_id FK",
      "  Scan->>CE: SET claim_case_id, claim_line_id on evidence rows",
      "```",
      "",
      "## Mapping",
      "",
      "| Scanner UI | `return_items.conditions` | `claim_cases.scanner_issue_type` | `claim_lines` |",
      "|------------|---------------------------|----------------------------------|---------------|",
      "| Damaged Product | `damaged_product` | `damaged_product` | `line_grain=return_item`, `discrepancy_kind=damage` |",
      "| Scratched | `scratched` | `scratched` | same |",
      "| Expired | `expired` | `expired` | same |",
      "| Missing Parts | `missing_parts` | `missing_parts` | same |",
      "| Wrong Item | `wrong_item` | `wrong_item` | `discrepancy_kind=wrong_item` |",
      "| Empty box (box wizard) | `empty_box` | `empty_box` | `package_id` on case + package evidence |",
      "| Damaged box | `damaged_box` | `damaged_box` | package-level evidence |",
      "| Wet (future chip) | `wet` | `wet` | same pattern |",
      "| Counterfeit suspicion | `counterfeit_suspect` | `counterfeit_suspect` | high priority case |",
      "| Other | `operator_other` | `operator_other` | free-text in `operator_note` evidence |",
      "",
      "## Photos",
      "",
      "- **Today:** `ItemUnitRecordSavePayload.evidenceUrls[]` → URLs on save",
      "- **Target:** each URL → `claim_evidence` row with `return_item_id`, `claim_case_id`, `scanner_issue_type`",
      "- Legacy URL may remain on `return_items` metadata during transition (read-only mirror)",
      "",
      "## Idempotency",
      "",
      "- Case: `cl:case:scanner:{org}:{return_item_id}:{scanner_issue_type}`",
      "- Line: existing `cl:return_item:{org}:{return_item_id}` (attach case after insert)",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "routing-and-sla-from-settings.md"),
    [
      "# Company routing + delayed/not-received from settings",
      "",
      "## Company routing resolution",
      "",
      "1. `claim_company_routing_rules` match: `(org, store?, claim_source, scanner_issue_type?)` lowest `priority` wins",
      "2. Else org-wide rule with `store_id IS NULL`",
      "3. Else `organization_settings.company_display_name` → `routed_company_display_name`",
      "4. Else `organization_settings.metadata->>'default_claim_company_key'`",
      "",
      "### Example seed (per org, not in migration)",
      "",
      "| claim_source | scanner_issue_type | routed_company_key |",
      "|--------------|-------------------|--------------------|",
      "| `scanner_operator_issue` | `damaged_product` | `tenant_ops` |",
      "| `delayed_not_received` | NULL | `marketplace_claims` |",
      "",
      "## Delayed / not-received SLA",
      "",
      "**Rule table:** `claim_sla_rules`",
      "",
      "| rule_key | claim_source | trigger_kind | default threshold | settings_path |",
      "|----------|--------------|--------------|-------------------|---------------|",
      "| `delayed_receive_default` | `delayed_not_received` | `days_since_expected_receive` | 30 | `metadata.delayed_not_received_days` |",
      "| `delayed_shipment_default` | `delayed_not_received` | `days_since_shipment` | 45 | `metadata.delayed_shipment_days` |",
      "",
      "**Resolution at case open / cron:**",
      "",
      "```sql",
      "-- threshold_days = COALESCE(",
      "--   (SELECT threshold_days FROM claim_sla_rules WHERE ...),",
      "--   (organization_settings.metadata->>'delayed_not_received_days')::int,",
      "--   30",
      "-- )",
      "```",
      "",
      "When breached: set `claim_cases.sla_breached_at`, emit `claim_case_events.sla_breached`, optional status → `investigating`.",
      "",
      "**No auto Amazon submit** — operator promotes to `waiting_amazon`.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "permissions-model.md"),
    [
      "# Permissions (claim case / evidence / routing)",
      "",
      "Catalog extension per [STORE_ACCESS_AND_PERMISSIONS_V1.md](../../docs/claims/STORE_ACCESS_AND_PERMISSIONS_V1.md).",
      "",
      "| Permission key | Min store access | Notes |",
      "|----------------|------------------|-------|",
      "| `claims.case.view` | view | Read cases in assigned stores |",
      "| `claims.case.open` | act | Create case from scanner / promote line |",
      "| `claims.case.assign` | act | Assign investigator |",
      "| `claims.case.close` | submit | Terminal close |",
      "| `claims.case.reopen` | submit + role | Reopen reimbursed |",
      "| `claims.evidence.upload` | act | Scanner photos + notes |",
      "| `claims.evidence.view` | view | Read evidence + signed URLs |",
      "| `claims.evidence.delete` | submit | Resolver/admin only |",
      "| `claims.routing.view` | view | Read routing rules |",
      "| `claims.routing.manage` | admin | CRUD `claim_company_routing_rules` |",
      "| `claims.sla.view` | view | Read SLA rules |",
      "| `claims.sla.manage` | admin | CRUD `claim_sla_rules` |",
      "",
      "## RLS (migration draft)",
      "",
      "- `service_role`: ALL on case/evidence/routing/sla/events",
      "- `authenticated`: SELECT own org (`get_my_organization_id()`); writes via API + service role",
      "- Store-scoped writes: enforced in `assertClaimPermission` + `user_store_assignments` (not in RLS v1)",
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
      "APPROVED_CLAIM_CASE_EVIDENCE_FOUNDATION_SCHEMA=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "staging-census.json"),
    JSON.stringify(census, null, 2),
  );

  const hardBlockers = blockers.filter(
    (b) => !b.includes("not connected") && !b.includes("partial"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None for dry-run") + "\n",
  );

  const nextPrompt = hardBlockers.some((b) => b.includes("claim_lines"))
    ? "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY — prerequisite claim_lines missing"
    : "CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-APPLY — apply case/evidence schema on staging after approval";

  const manifest = {
    prompt: "CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-DRYRUN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    migration_drafted: true,
    migration_file: `supabase/migrations/${MIGRATION_FILENAME}`,
    migration_applied: false,
    backfill_planned: false,
    scanner_issue_types: SCANNER_ISSUE_TYPES,
    blockers,
    hard_blockers: hardBlockers,
    approval_file: APPROVAL_REL,
    next_prompt: nextPrompt,
    status: hardBlockers.length ? "PASS_WITH_BLOCKERS" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  if (hardBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
