/**
 * CLAIM-RETURN-LINE-BACKFILL-DRYRUN — read-only census + dedupe plan (no DB writes).
 *
 *   npx tsx scripts/claim-return-line-backfill-dryrun.ts [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-backfill-dryrun";
const APPROVAL_REL = ".cursor/operator-approvals/claim-return-line-backfill-approval.md";
const SCHEMA_APPLY_BASE = ".cursor/audit-reports/claim-return-line-foundation-schema-apply";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function latestSchemaApplyRunId(): string | null {
  const base = path.join(process.cwd(), SCHEMA_APPLY_BASE);
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const id of dirs) {
    const manifest = path.join(base, id, "manifest.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8")) as { status?: string; claim_lines_exists?: boolean };
      if (m.status === "PASS" && m.claim_lines_exists) return id;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Idempotency key templates (execute must use these exactly). */
const IDEM = {
  import: (org: string, table: string, row: string) => `cl:import:${org}:${table}:${row}`,
  returnItem: (org: string, ri: string) => `cl:return_item:${org}:${ri}`,
  expectedGroup: (org: string, rootEp: string, kind: "short" | "overage") =>
    `cl:expected_group:${org}:${rootEp}:${kind}`,
} as const;

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

  const schemaApplyRunId = latestSchemaApplyRunId();
  if (!schemaApplyRunId) {
    blockers.push("No PASS claim-return-line-foundation-schema-apply manifest — run schema apply first");
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const claimLinesTable = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='claim_lines'
     ) AS ok`,
  );
  const claimLinesExists = Boolean((claimLinesTable.rows[0] as { ok: boolean }).ok);
  if (!claimLinesExists) {
    blockers.push("public.claim_lines does not exist on staging");
  }

  let claimLinesRowCount = 0;
  if (claimLinesExists) {
    const rc = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
    claimLinesRowCount = (rc.rows[0] as { c: number }).c;
    if (claimLinesRowCount > 0) {
      blockers.push(`claim_lines already has ${claimLinesRowCount} rows — reconcile before backfill`);
    }
  }

  // --- Lane census (raw) ---
  const ccRemoval = await client.query(`
    SELECT source_table, COUNT(*)::int AS c
    FROM public.claim_candidates
    WHERE source_table IN ('amazon_removals', 'amazon_removal_shipments')
    GROUP BY 1 ORDER BY c DESC
  `);
  const removalRaw = ccRemoval.rows.reduce((s: number, r: { c: number }) => s + r.c, 0);

  const ccReturnish = await client.query(`
    SELECT source_table, COUNT(*)::int AS c
    FROM public.claim_candidates
    WHERE source_table IN ('return_items', 'returns', 'amazon_returns')
    GROUP BY 1 ORDER BY c DESC
  `);
  const returnishRaw = ccReturnish.rows.reduce((s: number, r: { c: number }) => s + r.c, 0);

  const ri = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL)::int AS with_expected_item_id
    FROM public.return_items
  `);
  const riRow = ri.rows[0] as { active: number; with_expected_item_id: number };

  const invExists =
    (await client.query(
      `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='v_inventory_item_status'`,
    )).rowCount ?? 0;

  let invShort = 0;
  let invOver = 0;
  let invInProgress = 0;
  let invUnexpected = 0;
  let invResolvableShort = 0;
  let invResolvableOver = 0;

  if (invExists > 0) {
    const inv = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'unexpected')::int AS unexpected,
        COUNT(*) FILTER (WHERE total_expected > 0 AND total_scanned < total_expected)::int AS short_groups,
        COUNT(*) FILTER (WHERE total_expected > 0 AND total_scanned > total_expected)::int AS overage_groups
      FROM public.v_inventory_item_status
    `);
    const ir = inv.rows[0] as {
      in_progress: number;
      unexpected: number;
      short_groups: number;
      overage_groups: number;
    };
    invInProgress = ir.in_progress;
    invUnexpected = ir.unexpected;
    invShort = ir.short_groups;
    invOver = ir.overage_groups;

    const resolvable = await client.query(`
      WITH short_groups AS (
        SELECT v.organization_id, v.store_id, v.tracking_number, v.slip_code, v.sku, v.fnsku,
               'short'::text AS discrepancy_kind
        FROM public.v_inventory_item_status v
        WHERE v.total_expected > 0 AND v.total_scanned < v.total_expected
      ),
      over_groups AS (
        SELECT v.organization_id, v.store_id, v.tracking_number, v.slip_code, v.sku, v.fnsku,
               'overage'::text AS discrepancy_kind
        FROM public.v_inventory_item_status v
        WHERE v.total_expected > 0 AND v.total_scanned > v.total_expected
      ),
      groups AS (
        SELECT * FROM short_groups UNION ALL SELECT * FROM over_groups
      ),
      root_pick AS (
        SELECT g.*,
               (
                 SELECT ep.id
                 FROM public.expected_packages ep
                 LEFT JOIN LATERAL public.normalize_removal_tracking_operational(ep.tracking_number) tn ON TRUE
                 WHERE ep.organization_id = g.organization_id
                   AND (g.store_id IS NULL OR ep.store_id = g.store_id)
                   AND COALESCE(tn.operational, ep.tracking_number) IS NOT DISTINCT FROM g.tracking_number
                   AND ep.id_slip_contents IS NOT DISTINCT FROM g.slip_code
                   AND ep.sku IS NOT DISTINCT FROM g.sku
                   AND ep.fnsku IS NOT DISTINCT FROM g.fnsku
                   AND ep.build_source IN ('detail_shipment', 'detail_remainder', 'legacy')
                 ORDER BY ep.created_at
                 LIMIT 1
               ) AS root_ep_id
        FROM groups g
      )
      SELECT
        COUNT(*) FILTER (WHERE discrepancy_kind = 'short')::int AS short_total,
        COUNT(*) FILTER (WHERE discrepancy_kind = 'short' AND root_ep_id IS NOT NULL)::int AS short_resolvable,
        COUNT(*) FILTER (WHERE discrepancy_kind = 'overage')::int AS over_total,
        COUNT(*) FILTER (WHERE discrepancy_kind = 'overage' AND root_ep_id IS NOT NULL)::int AS over_resolvable
      FROM root_pick
    `);
    const rr = resolvable.rows[0] as {
      short_total: number;
      short_resolvable: number;
      over_total: number;
      over_resolvable: number;
    };
    invResolvableShort = rr.short_resolvable;
    invResolvableOver = rr.over_resolvable;
  } else {
    blockers.push("v_inventory_item_status missing");
  }

  // --- Dedupe within lanes ---
  const removalDedupe = await client.query(`
    SELECT
      COUNT(*)::int AS raw,
      COUNT(DISTINCT organization_id::text || '|' || source_table || '|' || source_row_id)::int AS distinct_keys
    FROM public.claim_candidates
    WHERE source_table IN ('amazon_removals', 'amazon_removal_shipments')
  `);
  const remD = removalDedupe.rows[0] as { raw: number; distinct_keys: number };

  const returnishDedupe = await client.query(`
    SELECT
      COUNT(*)::int AS raw,
      COUNT(DISTINCT organization_id::text || '|' || source_table || '|' || source_row_id)::int AS distinct_keys
    FROM public.claim_candidates
    WHERE source_table IN ('return_items', 'returns', 'amazon_returns')
  `);
  const retD = returnishDedupe.rows[0] as { raw: number; distinct_keys: number };

  // Cross-lane: return-ish candidates that also have a return_item with expected_item_id (return_item grain wins)
  const crossReturnItemWins = await client.query(`
    SELECT COUNT(*)::int AS c
    FROM public.claim_candidates cc
    WHERE cc.source_table = 'return_items'
      AND EXISTS (
        SELECT 1 FROM public.return_items ri
        WHERE ri.deleted_at IS NULL
          AND ri.expected_item_id IS NOT NULL
          AND ri.id::text = cc.source_row_id::text
          AND ri.organization_id = cc.organization_id
      )
  `);

  // Overlap: removal candidate source_row_id duplicated across tables (same row id space unlikely; count duplicate keys only)
  const removalDupSample = await client.query(`
    SELECT organization_id::text, source_table, source_row_id::text, COUNT(*)::int AS n
    FROM public.claim_candidates
    WHERE source_table IN ('amazon_removals', 'amazon_removal_shipments')
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 5
  `);

  await client.end();

  const removalInsert = remD.distinct_keys;
  const returnishInsert = retD.distinct_keys - Number(crossReturnItemWins.rows[0]?.c ?? 0);
  const returnItemInsert = riRow.with_expected_item_id;
  const expectedShortInsert = invResolvableShort;
  const expectedOverInsert = invResolvableOver;

  const estimatedAfterDedupe =
    removalInsert + Math.max(0, returnishInsert) + returnItemInsert + expectedShortInsert + expectedOverInsert;

  const lanes = {
    removal_claim_candidates: {
      raw: removalRaw,
      distinct_source_keys: remD.distinct_keys,
      duplicate_rows_skipped: remD.raw - remD.distinct_keys,
      planned_inserts: removalInsert,
      line_grain: "import_source",
      discrepancy_kind: "removal_financial",
      idempotency_template: IDEM.import("{org}", "{source_table}", "{source_row_id}"),
    },
    returnish_claim_candidates: {
      raw: returnishRaw,
      distinct_source_keys: retD.distinct_keys,
      duplicate_rows_skipped: retD.raw - retD.distinct_keys,
      cross_lane_skipped_return_item_wins: Number(crossReturnItemWins.rows[0]?.c ?? 0),
      planned_inserts: Math.max(0, returnishInsert),
      line_grain: "import_source",
      discrepancy_kind: "import_candidate",
      idempotency_template: IDEM.import("{org}", "{source_table}", "{source_row_id}"),
    },
    return_items_with_expected_item_id: {
      raw: riRow.with_expected_item_id,
      planned_inserts: returnItemInsert,
      line_grain: "return_item",
      discrepancy_kind: "other",
      idempotency_template: IDEM.returnItem("{org}", "{return_item_id}"),
    },
    expected_group_short: {
      raw_view_groups: invShort,
      resolvable_root_ep: invResolvableShort,
      unresolvable_skipped: invShort - invResolvableShort,
      planned_inserts: expectedShortInsert,
      line_grain: "expected_group",
      discrepancy_kind: "short",
      idempotency_template: IDEM.expectedGroup("{org}", "{root_ep}", "short"),
    },
    expected_group_overage: {
      raw_view_groups: invOver,
      resolvable_root_ep: invResolvableOver,
      unresolvable_skipped: invOver - invResolvableOver,
      planned_inserts: expectedOverInsert,
      line_grain: "expected_group",
      discrepancy_kind: "overage",
      idempotency_template: IDEM.expectedGroup("{org}", "{root_ep}", "overage"),
    },
  };

  const backfillPlan = {
    version: 1,
    prompt: "CLAIM-RETURN-LINE-BACKFILL-DRYRUN",
    run_id: runId,
    staging_ref: STAGING_REF,
    schema_apply_run_id: schemaApplyRunId,
    claim_lines_pre_backfill_rows: claimLinesRowCount,
    estimated_inserts_after_dedupe: estimatedAfterDedupe,
    lanes,
    execute_order: [
      "return_items_with_expected_item_id",
      "expected_group_short",
      "expected_group_overage",
      "removal_claim_candidates",
      "returnish_claim_candidates",
    ],
    batch_size: 500,
    on_conflict: "DO NOTHING on idempotency_key",
    forbidden: ["product_auto_create", "bulk_claim_submit", "amazon_api", "trid_migration"],
  };

  fs.writeFileSync(
    path.join(outDir, "backfill-census.md"),
    [
      "# Backfill census (staging — read-only)",
      "",
      `Schema apply run: \`${schemaApplyRunId ?? "missing"}\``,
      `claim_lines pre-backfill rows: **${claimLinesRowCount}**`,
      "",
      "## Removal claim_candidates",
      "",
      ...ccRemoval.rows.map((r: { source_table: string; c: number }) => `- \`${r.source_table}\`: **${r.c}**`),
      "",
      `**Raw total:** **${removalRaw}** | **Distinct source keys:** **${remD.distinct_keys}**`,
      "",
      "## Return-ish claim_candidates",
      "",
      ...ccReturnish.rows.map((r: { source_table: string; c: number }) => `- \`${r.source_table}\`: **${r.c}**`),
      "",
      `**Raw total:** **${returnishRaw}** | **Distinct source keys:** **${retD.distinct_keys}**`,
      "",
      "## return_items with expected_item_id",
      "",
      `- Active return_items: **${riRow.active}**`,
      `- With expected_item_id: **${riRow.with_expected_item_id}**`,
      "",
      "## v_inventory_item_status",
      "",
      `- in_progress (short status): **${invInProgress}**`,
      `- unexpected (overage status): **${invUnexpected}**`,
      `- Groups scanned < expected: **${invShort}** (resolvable root EP: **${invResolvableShort}**)`,
      `- Groups scanned > expected: **${invOver}** (resolvable root EP: **${invResolvableOver}**)`,
      "",
      "## Estimated inserts (post-dedupe)",
      "",
      "| Lane | Planned inserts |",
      "|------|----------------:|",
      `| removal import_source | ${removalInsert} |`,
      `| returnish import_source | ${Math.max(0, returnishInsert)} |`,
      `| return_item | ${returnItemInsert} |`,
      `| expected_group short | ${expectedShortInsert} |`,
      `| expected_group overage | ${expectedOverInsert} |`,
      `| **Total** | **${estimatedAfterDedupe}** |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "dedupe-plan.md"),
    [
      "# Dedupe plan",
      "",
      "## Idempotency keys (canonical)",
      "",
      "| Grain | Key pattern |",
      "|-------|-------------|",
      "| `import_source` | `cl:import:{org_id}:{source_table}:{source_row_id}` |",
      "| `return_item` | `cl:return_item:{org_id}:{return_item_id}` |",
      "| `expected_group` | `cl:expected_group:{org_id}:{expected_package_root_id}:{short\\|overage}` |",
      "",
      "Enforced by `claim_lines.idempotency_key` UNIQUE + `ON CONFLICT DO NOTHING` at execute.",
      "",
      "## Within-lane rules",
      "",
      "1. **return_item** — one line per `return_item_id` (natural PK).",
      "2. **expected_group** — one line per root EP + `discrepancy_kind`; resolve root EP via tracking/slip/sku/fnsku match on `expected_packages` (`detail_shipment`, `detail_remainder`, `legacy`). Unresolvable view groups are **skipped** (see census).",
      "3. **import_source** — one line per `(organization_id, source_table, source_row_id)`; duplicate candidate rows collapse to single insert.",
      "",
      "## Cross-lane precedence",
      "",
      "1. **return_item grain wins** over `claim_candidates` where `source_table='return_items'` and RI has `expected_item_id` — skip duplicate import_source line.",
      "2. **Do not** double-insert removal candidate if a `return_item` line already exists for the same physical unit (future: match via resolver; not in v1 backfill).",
      "3. **expected_group** lines are independent of import_source removal lines (different discrepancy_kind / grain).",
      "",
      "## source_table / source_row_id preservation",
      "",
      "All `import_source` inserts MUST set `source_table` + `source_row_id` from `claim_candidates` (and optional `claim_candidate_id`).",
      "`return_item` inserts set `return_item_id`, `expected_package_id` from `return_items.expected_item_id`, and may link `claim_candidate_id` when candidate exists.",
      "",
      "## Duplicate candidate sample (removal)",
      "",
      removalDupSample.rows.length
        ? removalDupSample.rows
            .map(
              (r: { organization_id: string; source_table: string; source_row_id: string; n: number }) =>
                `- org \`${r.organization_id}\` \`${r.source_table}\` / \`${r.source_row_id}\`: **${r.n}** rows`,
            )
            .join("\n")
        : "- No duplicate (org, source_table, source_row_id) tuples in removal lane",
      "",
      `Removal duplicates skipped: **${remD.raw - remD.distinct_keys}**`,
      `Return-ish cross-lane skipped (return_item wins): **${crossReturnItemWins.rows[0]?.c ?? 0}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "backfill-plan.json"), JSON.stringify(backfillPlan, null, 2));

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_REL}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_CLAIM_RETURN_LINE_BACKFILL=false",
      "```",
    ].join("\n") + "\n",
  );

  if (returnItemInsert === 0) {
    blockers.push(
      "Operational note: zero return_items with expected_item_id on staging — scanner lane backfill empty until receive linkage",
    );
  }
  if (invShort - invResolvableShort > 0) {
    blockers.push(
      `Operational note: ${invShort - invResolvableShort} short view groups lack resolvable root EP — will be skipped at execute`,
    );
  }

  const hardBlockers = blockers.filter((b) => !b.startsWith("Operational note:"));

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`)]
      : ["# Blockers", "", "- None"]
    ).join("\n") + "\n",
  );

  const nextPrompt = hardBlockers.length
    ? "CLAIM-RETURN-LINE-BACKFILL-DRYRUN-RETRY — resolve prerequisites"
    : "CLAIM-RETURN-LINE-BACKFILL-EXECUTE — governed staging INSERT after approval";

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-BACKFILL-DRYRUN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    schema_apply_run_id: schemaApplyRunId,
    claim_lines_exists: claimLinesExists,
    estimated_backfill_rows: estimatedAfterDedupe,
    lanes,
    blockers,
    hard_blockers: hardBlockers,
    approval_file: APPROVAL_REL,
    next_prompt: nextPrompt,
    status: hardBlockers.length ? "BLOCKED" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  if (hardBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
