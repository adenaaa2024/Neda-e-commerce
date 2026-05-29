/**
 * CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-DRYRUN — migration draft + staging backfill census (read-only).
 *
 *   npx tsx scripts/claim-return-line-foundation-schema-dryrun.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-foundation-schema-dryrun";
const APPROVAL_REL = ".cursor/operator-approvals/claim-return-line-foundation-schema-approval.md";
const MIGRATION_FILENAME = "20260831120000_claim_lines_foundation.sql";

const MIGRATION_DRAFT = `-- =============================================================================
-- CLAIM-RETURN-LINE-FOUNDATION — additive public.claim_lines (DRAFT — do not apply without approval)
-- Plan: claim-return-line-foundation-plan / schema-dryrun ${new Date().toISOString().slice(0, 10)}
-- Apply only when APPROVED_CLAIM_RETURN_LINE_FOUNDATION_SCHEMA=true on staging.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.claim_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  -- Bridge from detection / V2 generator (nullable until promoted)
  claim_candidate_id uuid REFERENCES public.claim_candidates (id) ON DELETE SET NULL,
  claim_candidate_draft_id uuid REFERENCES public.claim_candidate_drafts (id) ON DELETE SET NULL,

  -- Operational spine (hybrid grain — see line_grain)
  return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  expected_package_id uuid REFERENCES public.expected_packages (id) ON DELETE SET NULL,
  expected_package_root_id uuid REFERENCES public.expected_packages (id) ON DELETE SET NULL,

  product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,
  resolved_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,

  package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  pallet_id uuid REFERENCES public.pallets (id) ON DELETE SET NULL,
  slip_content_id uuid REFERENCES public.slip_contents (id) ON DELETE SET NULL,

  -- Context (denormalized for inbox / filing / AI read paths)
  tracking_number text,
  order_id text,
  sku text,
  fnsku text,
  asin text,

  -- Import / removal lineage when not item-grain
  source_table text,
  source_row_id text,
  source_detail_row_id uuid,
  source_shipment_row_id uuid,

  line_grain text NOT NULL,
  discrepancy_kind text NOT NULL,
  quantity_basis text,
  count_basis text,
  quantity_expected numeric(12, 4),
  quantity_actual numeric(12, 4),
  quantity_delta numeric(12, 4),

  status text NOT NULL DEFAULT 'detected',
  status_reason text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_lines_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT claim_lines_line_grain_chk CHECK (line_grain IN (
    'return_item',
    'expected_group',
    'import_source'
  )),
  CONSTRAINT claim_lines_discrepancy_kind_chk CHECK (discrepancy_kind IN (
    'short',
    'overage',
    'damage',
    'wrong_item',
    'missing_product_link',
    'removal_financial',
    'import_candidate',
    'other'
  )),
  CONSTRAINT claim_lines_quantity_basis_chk CHECK (
    quantity_basis IS NULL OR quantity_basis IN ('units', 'cases', 'weight_lb', 'unknown')
  ),
  CONSTRAINT claim_lines_count_basis_chk CHECK (
    count_basis IS NULL OR count_basis IN ('scan_count', 'expected_scan_quantity', 'package_count', 'unknown')
  ),
  CONSTRAINT claim_lines_status_chk CHECK (status IN (
    'detected',
    'evidence_needed',
    'claim_ready',
    'submitted',
    'reimbursed',
    'rejected',
    'closed'
  )),
  CONSTRAINT claim_lines_grain_fk_chk CHECK (
    (line_grain = 'return_item' AND return_item_id IS NOT NULL)
    OR (line_grain = 'expected_group' AND expected_package_root_id IS NOT NULL)
    OR (line_grain = 'import_source' AND source_table IS NOT NULL AND source_row_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.claim_lines IS
  'Operational claim line: one discrepancy at item, expected-group, or import-source grain. Detection inbox remains claim_candidates.';

COMMENT ON COLUMN public.claim_lines.line_grain IS
  'return_item = 1:1 return_items; expected_group = root EP + discrepancy_kind; import_source = candidate source pointer.';
COMMENT ON COLUMN public.claim_lines.expected_package_id IS
  'Allocated receive unit (receive_allocated EP) when return_item grain.';
COMMENT ON COLUMN public.claim_lines.expected_package_root_id IS
  'Root expected_packages row for short/overage group grain.';

CREATE INDEX idx_claim_lines_org_store_status
  ON public.claim_lines (organization_id, store_id, status);

CREATE INDEX idx_claim_lines_org_return_item
  ON public.claim_lines (organization_id, return_item_id)
  WHERE return_item_id IS NOT NULL;

CREATE INDEX idx_claim_lines_org_expected_package
  ON public.claim_lines (organization_id, expected_package_id)
  WHERE expected_package_id IS NOT NULL;

CREATE INDEX idx_claim_lines_org_expected_root
  ON public.claim_lines (organization_id, expected_package_root_id)
  WHERE expected_package_root_id IS NOT NULL;

CREATE INDEX idx_claim_lines_claim_candidate
  ON public.claim_lines (claim_candidate_id)
  WHERE claim_candidate_id IS NOT NULL;

CREATE INDEX idx_claim_lines_org_source
  ON public.claim_lines (organization_id, source_table, source_row_id)
  WHERE source_table IS NOT NULL;

CREATE INDEX idx_claim_lines_org_resolved_product
  ON public.claim_lines (organization_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_lines_set_updated_at ON public.claim_lines;
CREATE TRIGGER trg_claim_lines_set_updated_at
  BEFORE UPDATE ON public.claim_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.claim_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_lines_service_role_all" ON public.claim_lines;
CREATE POLICY "claim_lines_service_role_all"
  ON public.claim_lines
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_lines_select_own_org" ON public.claim_lines;
CREATE POLICY "claim_lines_select_own_org"
  ON public.claim_lines
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_lines TO service_role;
GRANT SELECT ON public.claim_lines TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(
    d.getUTCMinutes(),
  )}${p(d.getUTCSeconds())}Z`;
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

  const blockers: string[] = [];
  const claimLinesExists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='claim_lines'`,
  );
  if ((claimLinesExists.rowCount ?? 0) > 0) {
    blockers.push("claim_lines already exists on staging — reconcile before apply");
  }

  const ccRemoval = await client.query(`
    SELECT source_table, COUNT(*)::int AS c
    FROM public.claim_candidates
    WHERE source_table IN ('amazon_removals', 'amazon_removal_shipments')
    GROUP BY 1 ORDER BY c DESC
  `);
  const ccRemovalTotal = ccRemoval.rows.reduce((s: number, r: { c: number }) => s + r.c, 0);

  const ccReturnish = await client.query(`
    SELECT COUNT(*)::int AS c FROM public.claim_candidates
    WHERE source_table IN ('return_items', 'returns', 'amazon_returns')
  `);

  const ccDraftsRemoval = await client.query(`
    SELECT source_table, COUNT(*)::int AS c
    FROM public.claim_candidate_drafts
    WHERE source_table IN ('amazon_removals', 'amazon_removal_shipments')
    GROUP BY 1 ORDER BY c DESC
  `);

  const ri = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL)::int AS with_expected_item_id,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS resolved
    FROM public.return_items
  `);

  const invViewExists = await client.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='v_inventory_item_status'`,
  );
  let shortOver: { short_groups: number; overage_groups: number; in_progress: number; unexpected: number } = {
    short_groups: 0,
    overage_groups: 0,
    in_progress: 0,
    unexpected: 0,
  };
  if ((invViewExists.rowCount ?? 0) > 0) {
    const inv = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'unexpected')::int AS unexpected,
        COUNT(*) FILTER (WHERE total_expected > 0 AND total_scanned < total_expected)::int AS short_groups,
        COUNT(*) FILTER (WHERE total_expected > 0 AND total_scanned > total_expected)::int AS overage_groups
      FROM public.v_inventory_item_status
    `);
    shortOver = inv.rows[0] as typeof shortOver;
  } else {
    blockers.push("v_inventory_item_status missing — cannot census short/overage from view");
  }

  const samples: Record<string, unknown>[] = [];

  const candSample = await client.query(`
    SELECT id::text, organization_id::text, source_table, source_row_id::text, sku, resolved_product_id::text
    FROM public.claim_candidates
    WHERE source_table = 'amazon_removal_shipments'
    ORDER BY created_at DESC NULLS LAST
    LIMIT 5
  `);
  for (const r of candSample.rows) samples.push({ lane: "import_candidate", ...r });

  const riSample = await client.query(`
    SELECT ri.id::text, ri.organization_id::text, ri.expected_item_id::text, ri.order_id, ri.sku,
           ri.package_id::text, ri.resolved_product_id::text
    FROM public.return_items ri
    WHERE ri.deleted_at IS NULL AND ri.expected_item_id IS NOT NULL
    LIMIT 5
  `);
  for (const r of riSample.rows) samples.push({ lane: "return_item", ...r });

  if ((invViewExists.rowCount ?? 0) > 0) {
    const invSample = await client.query(`
      SELECT organization_id::text, tracking_number, slip_code, sku, status,
             total_expected, total_scanned
      FROM public.v_inventory_item_status
      WHERE status IN ('in_progress', 'unexpected')
      LIMIT 5
    `);
    for (const r of invSample.rows) samples.push({ lane: "expected_group", ...r });
  }

  await client.end();

  const riRow = ri.rows[0] as Record<string, number>;
  const candidateBackfillEstimate =
    ccRemovalTotal +
    Number(ccReturnish.rows[0]?.c ?? 0) +
    Number(riRow.with_expected_item_id ?? 0) +
    shortOver.short_groups +
    shortOver.overage_groups;

  const backfillByLane = {
    import_source_removal_candidates: ccRemovalTotal,
    import_source_returnish_candidates: Number(ccReturnish.rows[0]?.c ?? 0),
    return_item_grain: Number(riRow.with_expected_item_id ?? 0),
    expected_group_short: shortOver.short_groups,
    expected_group_overage: shortOver.overage_groups,
    estimated_total_rows_upper_bound: candidateBackfillEstimate,
    note: "Upper bound — dedupe by idempotency_key will reduce actual INSERT count",
  };

  fs.writeFileSync(path.join(outDir, "claim-lines-migration-draft.sql"), MIGRATION_DRAFT);

  fs.writeFileSync(
    path.join(outDir, "schema-dryrun-report.md"),
    [
      "# Schema dry-run report",
      "",
      `- **Run:** \`${OUT_BASE}/${runId}/\``,
      `- **Branch:** \`${branch}\``,
      `- **Staging:** \`${STAGING_REF}\``,
      `- **Migration drafted:** **yes** → \`claim-lines-migration-draft.sql\` (proposed name: \`${MIGRATION_FILENAME}\`)`,
      `- **Migration applied:** **no**`,
      "",
      "## Hybrid grain (recap)",
      "",
      "| lane | line_grain | Primary FK / key |",
      "|------|------------|------------------|",
      "| Scanner/receive | `return_item` | `return_item_id` + `expected_package_id` |",
      "| Short/overage | `expected_group` | `expected_package_root_id` + `discrepancy_kind` |",
      "| Removal/import | `import_source` | `source_table` + `source_row_id` + optional `claim_candidate_id` |",
      "",
      "## Indexes / FKs in draft",
      "",
      "- FKs: organizations, stores, claim_candidates, claim_candidate_drafts, return_items, expected_packages (×2), products, packages, pallets, slip_contents",
      "- Partial indexes on return_item_id, expected_package_id, expected_package_root_id, claim_candidate_id, source pointer, resolved_product_id",
      "- Unique `idempotency_key`",
      "- CHECK: grain ↔ required FKs",
      "- RLS: service_role all + authenticated SELECT own org",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "backfill-census.md"),
    [
      "# Backfill census (staging — read-only)",
      "",
      "## claim_candidates → removal sources",
      "",
      ...ccRemoval.rows.map(
        (r: { source_table: string; c: number }) => `- \`${r.source_table}\`: **${r.c}**`,
      ),
      "",
      `**Total removal/import lane:** **${ccRemovalTotal}**`,
      "",
      "## claim_candidates → return paths",
      "",
      `- \`return_items\` / \`returns\` / \`amazon_returns\`: **${ccReturnish.rows[0]?.c ?? 0}**`,
      "",
      "## claim_candidate_drafts → removal (V2)",
      "",
      ...ccDraftsRemoval.rows.map(
        (r: { source_table: string; c: number }) => `- \`${r.source_table}\`: **${r.c}**`,
      ),
      "",
      "## return_items (scanner lane)",
      "",
      `- Active: **${riRow.active ?? 0}**`,
      `- With \`expected_item_id\`: **${riRow.with_expected_item_id ?? 0}**`,
      `- Resolved product: **${riRow.resolved ?? 0}**`,
      "",
      "## v_inventory_item_status (expected vs scanned)",
      "",
      `- \`in_progress\` (short): **${shortOver.in_progress}**`,
      `- \`unexpected\` (overage): **${shortOver.unexpected}**`,
      `- Groups where scanned < expected: **${shortOver.short_groups}**`,
      `- Groups where scanned > expected: **${shortOver.overage_groups}**`,
      "",
      "## Estimated backfill volume (upper bound)",
      "",
      "| Lane | Rows |",
      "|------|-----:|",
      `| import_source (removals) | ${ccRemovalTotal} |`,
      `| import_source (returnish) | ${ccReturnish.rows[0]?.c ?? 0} |`,
      `| return_item | ${riRow.with_expected_item_id ?? 0} |`,
      `| expected_group short | ${shortOver.short_groups} |`,
      `| expected_group overage | ${shortOver.overage_groups} |`,
      `| **Estimated total (pre-dedupe)** | **${candidateBackfillEstimate}** |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "linkage-sample.md"),
    ["# Linkage samples (staging)", "", "```json", JSON.stringify(samples, null, 2), "```"].join("\n") + "\n",
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
      "APPROVED_CLAIM_RETURN_LINE_FOUNDATION_SCHEMA=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`)]
      : ["# Blockers", "", "- None for dry-run (apply blocked until approval)."]
    ).join("\n") + "\n",
  );

  const nextPrompt =
    blockers.length > 0
      ? "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-RESOLVE — fix blockers before staging apply"
      : "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY — apply claim_lines migration on staging after approval";

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-DRYRUN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    migration_drafted: true,
    migration_applied: false,
    migration_file: `supabase/migrations/${MIGRATION_FILENAME}`,
    candidate_backfill_estimate: candidateBackfillEstimate,
    backfill_by_lane: backfillByLane,
    blockers,
    approval_file: APPROVAL_REL,
    next_prompt: nextPrompt,
    status: blockers.length ? "PASS_WITH_BLOCKERS" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
