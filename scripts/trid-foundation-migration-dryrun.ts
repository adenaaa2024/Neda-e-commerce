/**
 * TRID-FOUNDATION-MIGRATION-DRYRUN — draft additive migration (no apply)
 *
 *   npx tsx scripts/trid-foundation-migration-dryrun.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/trid-foundation-migration-dryrun";
const APPROVAL_PATH = ".cursor/operator-approvals/trid-foundation-migration-approval.md";
const CLAIM_LINES_DRYRUN_BASE = ".cursor/audit-reports/claim-return-line-foundation-schema-dryrun";
const MIGRATION_FILENAME = "20260832120000_trid_foundation.sql";

const LIFECYCLE_STATUSES = [
  "detected",
  "evidence_needed",
  "claim_ready",
  "submitted",
  "reimbursed",
  "rejected",
  "closed",
] as const;

const MIGRATION_DRAFT = `-- =============================================================================
-- TRID FOUNDATION — additive trid_entities / trid_links / trid_events (DRAFT)
-- Prerequisite: public.claim_lines (20260831120000_claim_lines_foundation.sql)
-- Financial layer: REUSE financial_reference_resolver.trid_key — no duplicate FRR tables.
-- Apply only when APPROVED_TRID_FOUNDATION_MIGRATION=true on staging.
-- =============================================================================

BEGIN;

-- ── trid_entities: operational discrepancy anchor (1:1 claim_line at operational grain) ──
CREATE TABLE IF NOT EXISTS public.trid_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  entity_layer text NOT NULL DEFAULT 'operational',
  status text NOT NULL DEFAULT 'detected',

  claim_line_id uuid NOT NULL REFERENCES public.claim_lines (id) ON DELETE CASCADE,

  -- Operator-selected financial key from FRR (not a separate financial TRID table)
  selected_financial_trid_key text,
  selected_frr_source_table text,
  selected_frr_source_row_id text,

  -- Filing bundle (many claim_lines may reference same filing request via links / entity updates)
  claim_filing_request_id uuid REFERENCES public.claim_filing_requests (id) ON DELETE SET NULL,

  primary_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,
  primary_order_id text,
  primary_sku text,

  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trid_entities_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT trid_entities_claim_line_id_key UNIQUE (claim_line_id),
  CONSTRAINT trid_entities_entity_layer_chk CHECK (entity_layer IN (
    'operational',
    'filing_bundle'
  )),
  CONSTRAINT trid_entities_status_chk CHECK (status IN (
    'detected',
    'evidence_needed',
    'claim_ready',
    'submitted',
    'reimbursed',
    'rejected',
    'closed'
  )),
  CONSTRAINT trid_entities_frr_selection_chk CHECK (
    selected_financial_trid_key IS NULL
    OR (selected_frr_source_table IS NOT NULL AND selected_frr_source_row_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.trid_entities IS
  'Operational TRID entity: one discrepancy / claim_line. Financial keys reference FRR.trid_key; filing groups via claim_filing_request_id + trid_links.';

COMMENT ON COLUMN public.trid_entities.selected_financial_trid_key IS
  'Reuse financial_reference_resolver.trid_key — do not duplicate financial resolver rows.';

CREATE INDEX idx_trid_entities_org_store_status
  ON public.trid_entities (organization_id, store_id, status);

CREATE INDEX idx_trid_entities_org_filing
  ON public.trid_entities (organization_id, claim_filing_request_id)
  WHERE claim_filing_request_id IS NOT NULL;

CREATE INDEX idx_trid_entities_selected_trid_key
  ON public.trid_entities (organization_id, selected_financial_trid_key)
  WHERE selected_financial_trid_key IS NOT NULL;

-- ── trid_links: polymorphic evidence / spine edges (complements claim_reference_edges) ──
CREATE TABLE IF NOT EXISTS public.trid_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  trid_entity_id uuid NOT NULL REFERENCES public.trid_entities (id) ON DELETE CASCADE,

  link_role text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid,
  target_trid_key text,
  target_source_table text,
  target_source_row_id text,

  confidence numeric(10, 4),
  source_table text,
  source_row_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trid_links_link_role_chk CHECK (link_role IN (
    'operational_source',
    'financial_match',
    'evidence',
    'filing',
    'product_spine'
  )),
  CONSTRAINT trid_links_target_kind_chk CHECK (target_kind IN (
    'claim_lines',
    'return_items',
    'expected_packages',
    'products',
    'claim_filing_requests',
    'financial_reference_resolver',
    'claim_reference_edges',
    'claim_candidate_drafts',
    'packages',
    'slip_contents'
  )),
  CONSTRAINT trid_links_target_ref_chk CHECK (
    target_id IS NOT NULL
    OR target_trid_key IS NOT NULL
    OR (target_source_table IS NOT NULL AND target_source_row_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.trid_links IS
  'Edges from trid_entity to operational/financial/filing targets. FRR links use target_trid_key + source pointer — no financial TRID duplicate table.';

CREATE INDEX idx_trid_links_entity
  ON public.trid_links (trid_entity_id);

CREATE INDEX idx_trid_links_org_target_kind_id
  ON public.trid_links (organization_id, target_kind, target_id)
  WHERE target_id IS NOT NULL;

CREATE INDEX idx_trid_links_org_frr_trid_key
  ON public.trid_links (organization_id, target_trid_key)
  WHERE target_kind = 'financial_reference_resolver' AND target_trid_key IS NOT NULL;

CREATE UNIQUE INDEX uq_trid_links_entity_role_target
  ON public.trid_links (
    trid_entity_id,
    link_role,
    target_kind,
    COALESCE(target_id::text, ''),
    COALESCE(target_trid_key, ''),
    COALESCE(target_source_table, ''),
    COALESCE(target_source_row_id, '')
  );

-- ── trid_events: append-only lifecycle audit ──
CREATE TABLE IF NOT EXISTS public.trid_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  trid_entity_id uuid NOT NULL REFERENCES public.trid_entities (id) ON DELETE CASCADE,

  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'system',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trid_events_actor_kind_chk CHECK (actor_kind IN ('system', 'operator', 'agent')),
  CONSTRAINT trid_events_from_status_chk CHECK (
    from_status IS NULL OR from_status IN (
      'detected', 'evidence_needed', 'claim_ready', 'submitted', 'reimbursed', 'rejected', 'closed'
    )
  ),
  CONSTRAINT trid_events_to_status_chk CHECK (
    to_status IS NULL OR to_status IN (
      'detected', 'evidence_needed', 'claim_ready', 'submitted', 'reimbursed', 'rejected', 'closed'
    )
  )
);

COMMENT ON TABLE public.trid_events IS
  'Append-only TRID lifecycle audit; mirrors claim_evidence_lineage_events pattern for entity status transitions.';

CREATE INDEX idx_trid_events_entity_created
  ON public.trid_events (trid_entity_id, created_at DESC);

CREATE INDEX idx_trid_events_org_type
  ON public.trid_events (organization_id, event_type);

-- ── updated_at trigger (reuse set_updated_at if present) ──
DROP TRIGGER IF EXISTS trg_trid_entities_set_updated_at ON public.trid_entities;
CREATE TRIGGER trg_trid_entities_set_updated_at
  BEFORE UPDATE ON public.trid_entities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──
ALTER TABLE public.trid_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trid_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trid_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trid_entities_service_role_all" ON public.trid_entities;
CREATE POLICY "trid_entities_service_role_all"
  ON public.trid_entities AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "trid_entities_select_own_org" ON public.trid_entities;
CREATE POLICY "trid_entities_select_own_org"
  ON public.trid_entities FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "trid_links_service_role_all" ON public.trid_links;
CREATE POLICY "trid_links_service_role_all"
  ON public.trid_links AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "trid_links_select_own_org" ON public.trid_links;
CREATE POLICY "trid_links_select_own_org"
  ON public.trid_links FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "trid_events_service_role_all" ON public.trid_events;
CREATE POLICY "trid_events_service_role_all"
  ON public.trid_events AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "trid_events_select_own_org" ON public.trid_events;
CREATE POLICY "trid_events_select_own_org"
  ON public.trid_events FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trid_entities TO service_role;
GRANT SELECT ON public.trid_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trid_links TO service_role;
GRANT SELECT ON public.trid_links TO authenticated;
GRANT SELECT, INSERT ON public.trid_events TO service_role;
GRANT SELECT ON public.trid_events TO authenticated;

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

function latestClaimLinesDryrun(): { runId: string | null; manifest: Record<string, unknown> | null } {
  const base = path.join(process.cwd(), CLAIM_LINES_DRYRUN_BASE);
  if (!fs.existsSync(base)) return { runId: null, manifest: null };
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const id of dirs) {
    const mp = path.join(base, id, "manifest.json");
    if (fs.existsSync(mp)) {
      return { runId: id, manifest: JSON.parse(fs.readFileSync(mp, "utf8")) as Record<string, unknown> };
    }
  }
  return { runId: dirs[0] ?? null, manifest: null };
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

function approvalContent(runId: string): string {
  return `# TRID foundation migration — operator approval

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Prerequisite | \`claim_lines\` table applied first |
| Migration | \`${MIGRATION_FILENAME}\` |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_TRID_FOUNDATION_MIGRATION=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_TRID_FOUNDATION_MIGRATION=false
Approved by:
UTC date:
Plan run_id: ${runId}
\`\`\`
`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();

  const claimLinesDry = latestClaimLinesDryrun();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);

  let census: Record<string, unknown> = {};

  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging census skipped — guard failed (expected ${STAGING_REF})`);
  } else {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const claimLinesExists = await tableExists(client, "claim_lines");
    const tridEntitiesExists = await tableExists(client, "trid_entities");
    const frrExists = await tableExists(client, "financial_reference_resolver");
    const cfrExists = await tableExists(client, "claim_filing_requests");

    if (!claimLinesExists) {
      blockers.push("Prerequisite: public.claim_lines missing — apply claim-return-line-foundation migration first");
    }
    if (tridEntitiesExists) {
      blockers.push("trid_entities already exists on staging — reconcile before apply");
    }
    if (!frrExists) {
      blockers.push("financial_reference_resolver missing — financial TRID reuse blocked");
    }

    const counts = async (table: string) => {
      try {
        const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table}`);
        return (r.rows[0] as { c: number }).c;
      } catch {
        return null;
      }
    };

    census = {
      claim_lines_exists: claimLinesExists,
      trid_entities_exists: tridEntitiesExists,
      financial_reference_resolver_exists: frrExists,
      claim_filing_requests_exists: cfrExists,
      claim_lines_count: claimLinesExists ? await counts("claim_lines") : null,
      frr_count: frrExists ? await counts("financial_reference_resolver") : null,
      claim_filing_requests_count: cfrExists ? await counts("claim_filing_requests") : null,
    };

    if (frrExists) {
      const tridKeys = await client.query(
        `SELECT COUNT(DISTINCT trid_key)::int AS c FROM public.financial_reference_resolver WHERE trid_key IS NOT NULL`,
      );
      census.frr_distinct_trid_keys = (tridKeys.rows[0] as { c: number }).c;
    }

    await client.end();
  }

  if (!claimLinesDry.runId) {
    blockers.push("No claim-return-line-foundation-schema-dryrun artifact found — run prerequisite dryrun");
  } else if (claimLinesDry.manifest?.migration_drafted !== true) {
    blockers.push(`claim_lines dryrun ${claimLinesDry.runId} missing migration_drafted=true`);
  }

  fs.writeFileSync(path.join(outDir, "trid-migration-draft.sql"), MIGRATION_DRAFT);
  fs.writeFileSync(
    path.join(process.cwd(), "supabase/migrations", MIGRATION_FILENAME),
    MIGRATION_DRAFT,
  );

  fs.writeFileSync(
    path.join(outDir, "linkage-map.md"),
    [
      "# TRID linkage map",
      "",
      "## Grain layers",
      "",
      "| Layer | Grain | Storage |",
      "|-------|-------|---------|",
      "| Operational | One discrepancy / **claim_line** | `trid_entities.claim_line_id` (unique) |",
      "| Financial | **Reuse FRR** `trid_key` | `selected_financial_trid_key` + `trid_links` → FRR pointer |",
      "| Filing | Many claim_lines → one case | `claim_filing_request_id` + `link_role=filing` |",
      "",
      "## Entity → spine FKs (via claim_lines + trid_links)",
      "",
      "| Target | Join path |",
      "|--------|-----------|",
      "| **claim_lines** | `trid_entities.claim_line_id` |",
      "| **return_items** | `claim_lines.return_item_id` OR `trid_links.target_kind=return_items` |",
      "| **expected_packages** | `claim_lines.expected_package_id` / `expected_package_root_id` OR link |",
      "| **products** | `claim_lines.resolved_product_id` OR `trid_links.target_kind=products` |",
      "| **claim_filing_requests** | `trid_entities.claim_filing_request_id` OR link |",
      "| **financial_reference_resolver** | `selected_financial_trid_key` + source_table/row_id; **no duplicate financial TRID table** |",
      "",
      "## claim_lines dryrun input",
      "",
      claimLinesDry.runId
        ? `- Loaded: \`${CLAIM_LINES_DRYRUN_BASE}/${claimLinesDry.runId}/\``
        : "- **Not found**",
      "",
      "```mermaid",
      "flowchart LR",
      "  CL[claim_lines]",
      "  TE[trid_entities]",
      "  TL[trid_links]",
      "  TEV[trid_events]",
      "  RI[return_items]",
      "  EP[expected_packages]",
      "  P[products]",
      "  FRR[financial_reference_resolver.trid_key]",
      "  CFR[claim_filing_requests]",
      "  CL --> TE",
      "  TE --> TL",
      "  TE --> TEV",
      "  CL --> RI",
      "  CL --> EP",
      "  CL --> P",
      "  TL --> FRR",
      "  TE --> CFR",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "lifecycle-event-contract.md"),
    [
      "# Lifecycle & event contract",
      "",
      "## `trid_entities.status`",
      "",
      ...LIFECYCLE_STATUSES.map(
        (s) =>
          `- \`${s}\` — see trid-foundation-plan lifecycle mapping; transitions logged in \`trid_events\``,
      ),
      "",
      "## `trid_events.event_type` (initial set)",
      "",
      "| event_type | When |",
      "|------------|------|",
      "| `entity_created` | Materializer creates entity from claim_line |",
      "| `status_transition` | Any status change (from_status → to_status) |",
      "| `financial_trid_selected` | Operator selects FRR trid_key |",
      "| `filing_attached` | claim_filing_request linked |",
      "| `evidence_link_added` | trid_links row inserted (mirror in payload) |",
      "",
      "## Rules",
      "",
      "- Append-only: no UPDATE/DELETE on trid_events",
      "- Status changes MUST write trid_events row",
      "- Filing still gated — no auto-submit",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "frr-reuse-contract.md"),
    [
      "# FRR reuse contract",
      "",
      "## Do NOT duplicate",
      "",
      "- No `financial_trid_entities` table",
      "- No second copy of `trid_key` registry",
      "",
      "## Reuse `financial_reference_resolver`",
      "",
      "| Field | Use on trid_entities | Use on trid_links |",
      "|-------|---------------------|-------------------|",
      "| `trid_key` | `selected_financial_trid_key` | `target_trid_key` when target_kind=`financial_reference_resolver` |",
      "| `source_table` | `selected_frr_source_table` | `target_source_table` |",
      "| `source_row_id` | `selected_frr_source_row_id` | `target_source_row_id` |",
      "",
      "## Existing graph (keep)",
      "",
      "- `claim_reference_edges` with `edge_type` claim_to_trid / operational_to_financial",
      "- `claim_evidence_lineage_events` for draft-level lineage",
      "- `claim_filing_requests.payload.trid` extension (TridFilingPayloadExtension)",
      "",
      "## Convergence (deferred)",
      "",
      "Materializer may copy accepted edges into trid_links; do not drop claim_reference_edges in this migration.",
      "",
      "## Staging census",
      "",
      "```json",
      JSON.stringify(census, null, 2),
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_TRID_FOUNDATION_MIGRATION=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`), "", "Dry-run migration drafted; apply blocked until prerequisites + approval."]
      : ["# Blockers", "", "- None for draft. Apply blocked until approval + claim_lines on staging."]
    ).join("\n") + "\n",
  );

  const prerequisiteBlockers = blockers.filter(
    (b) =>
      b.includes("claim_lines") ||
      b.includes("prerequisite") ||
      b.includes("claim-return-line"),
  );

  const nextPrompt =
    prerequisiteBlockers.length > 0
      ? "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY — apply claim_lines on staging before TRID migration"
      : blockers.some((b) => b.includes("trid_entities already"))
        ? "TRID-FOUNDATION-MIGRATION-RECONCILE — trid tables exist; reconcile live DDL"
        : "TRID-FOUNDATION-MIGRATION-APPLY — apply trid foundation migration on staging after approval";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "TRID-FOUNDATION-MIGRATION-DRYRUN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        migration_drafted: true,
        migration_applied: false,
        migration_file: `supabase/migrations/${MIGRATION_FILENAME}`,
        claim_lines_dryrun_run_id: claimLinesDry.runId,
        prerequisite_blockers: prerequisiteBlockers,
        blockers,
        census,
        approval_file: APPROVAL_PATH,
        exact_next_prompt: nextPrompt,
        no_db_writes: true,
        status: blockers.length ? "PASS_WITH_BLOCKERS" : "PASS",
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(process.cwd(), APPROVAL_PATH), approvalContent(runId));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        migration_drafted: true,
        prerequisite_blockers: prerequisiteBlockers.length,
        blockers: blockers.length,
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
