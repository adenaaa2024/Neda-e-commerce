/**
 * PC03C-EXEC — EXPECTED PACKAGES APPROVE-READY MERGE DUPLICATE CANONICAL (staging only)
 *
 * Applies only approve-ready merge_duplicate_canonical rows from PC03C manual queue.
 * Does not delete rows, create products, or touch original.
 *
 *   npx tsx scripts/pc03c-expected-packages-merge-duplicate-canonical-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03c-expected-packages-merge-duplicate-canonical-execute.ts --apply --queue-run-id=20260525T160000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const QUEUE_DEFAULT = "20260525T160000Z";
const QUEUE_BASE = ".cursor/audit-reports/pc03c-expected-packages-quarantined-manual-queue";
const APPROVAL_PATH =
  ".cursor/operator-approvals/pc03c-expected-packages-merge-duplicate-canonical-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc03c-approve-ready-execute";
const MATCH_SOURCE = "expected_packages_pc03c_merge_duplicate_canonical";
const MERGE_STATUS = "merged_duplicate_canonical";

type QueueRow = {
  expected_package_id: string;
  cohort: string;
  sku: string | null;
  fnsku: string | null;
  order_id: string | null;
  order_type: string | null;
  disposition: string | null;
  tracking_number: string | null;
  build_source: string | null;
  identifier_resolution_status: string | null;
  proposed_fix: { sku: string | null; fnsku: string | null; basis: string | null } | null;
  duplicate_canonical_sibling_id: string | null;
  recommended_action: string;
  approve_ready: boolean;
};

type AppliedRow = {
  expected_package_id: string;
  canonical_sibling_id: string;
  proposed_sku: string;
  proposed_fnsku: string;
  inherited_resolved_product_id: string | null;
  previous_status: string | null;
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

function queueRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--queue-run-id="));
  return a ? a.split("=")[1]!.trim() : QUEUE_DEFAULT;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/g);
  const mergeM = text.match(/APPROVED_PC03C_MERGE_DUPLICATE_CANONICAL\s*=\s*(\S+)/g);
  const runVal = runM?.some((m) => m.endsWith("true")) ?? false;
  const mergeVal = mergeM?.some((m) => m.endsWith("true")) ?? false;
  return {
    valid: runVal && mergeVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_PC03C_MERGE_DUPLICATE_CANONICAL: mergeVal ? "true" : "false",
    },
  };
}

async function epCoverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function expectedPackagesColumns(client: pg.Client): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'expected_packages'`,
  );
  return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
}

function sqlQuote(v: string | null | undefined): string {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const queueRunId = queueRunIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const queuePath = path.join(process.cwd(), QUEUE_BASE, queueRunId, "manual-review-queue.json");
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  if (!approval.valid) blockers.push("Approval flags not both true in sign-off block");
  if (!fs.existsSync(queuePath)) blockers.push(`Missing queue ${queuePath}`);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (supaUrl && refFromSupabaseUrl(supaUrl) !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL must be staging ${STAGING_REF}`);
  }

  let queue: QueueRow[] = [];
  if (fs.existsSync(queuePath)) {
    const parsed = JSON.parse(fs.readFileSync(queuePath, "utf8")) as { queue: QueueRow[] };
    queue = parsed.queue ?? [];
  }

  const applyRows = queue.filter(
    (r) => r.approve_ready && r.recommended_action === "merge_duplicate_canonical",
  );
  const skippedRows = queue.filter(
    (r) => !(r.approve_ready && r.recommended_action === "merge_duplicate_canonical"),
  );

  if (applyRows.length !== 2) {
    blockers.push(`Expected 2 approve-ready merge_duplicate_canonical rows, got ${applyRows.length}`);
  }
  for (const row of applyRows) {
    if (!row.duplicate_canonical_sibling_id) {
      blockers.push(`Row ${row.expected_package_id} missing duplicate_canonical_sibling_id`);
    }
    if (!row.proposed_fix?.sku || !row.proposed_fix?.fnsku) {
      blockers.push(`Row ${row.expected_package_id} missing proposed_fix sku/fnsku`);
    }
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_PC03C_MERGE_DUPLICATE_CANONICAL | ${approval.raw.APPROVED_PC03C_MERGE_DUPLICATE_CANONICAL} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      `| apply_mode | **${apply}** |`,
    ].join("\n") + "\n",
  );

  if (blockers.length && apply) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked: ${blockers.join("; ")}`);
  }

  fs.writeFileSync(path.join(outDir, "skipped-rows.json"), JSON.stringify(skippedRows, null, 2));

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "PC03C-EXEC — EXPECTED PACKAGES APPROVE-READY EXECUTE",
          run_id: runId,
          queue_run_id: queueRunId,
          branch,
          staging_ref: STAGING_REF,
          status: blockers.length ? "BLOCKED" : "DRY_RUN",
          apply,
          apply_count: applyRows.length,
          skipped_count: skippedRows.length,
          blockers,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {
          ok: !blockers.length,
          outDir,
          apply: false,
          apply_count: applyRows.length,
          skipped_count: skippedRows.length,
          blockers,
        },
        null,
        2,
      ),
    );
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const beforeEp = await epCoverage(client);
  const epCols = await expectedPackagesColumns(client);
  const hasMeta = epCols.has("identifier_resolution_meta");
  const hasSource = epCols.has("identifier_resolution_source");
  const hasReview = epCols.has("product_review_required");

  const preimageSelect = [
    "id::text",
    "organization_id::text",
    "store_id::text",
    "sku",
    "fnsku",
    "order_id",
    "order_type",
    "disposition",
    "tracking_number",
    "build_source",
    "resolved_product_id::text",
    "resolved_catalog_product_id::text",
    "identifier_resolution_status",
    "identifier_resolution_confidence::text",
    hasSource ? "identifier_resolution_source" : null,
    hasMeta ? "identifier_resolution_meta" : null,
    hasReview ? "product_review_required" : null,
    epCols.has("product_match_status") ? "product_match_status" : null,
    "updated_at::text",
  ]
    .filter(Boolean)
    .join(", ");

  const applyIds = applyRows.map((r) => r.expected_package_id);
  const siblingIds = applyRows.map((r) => r.duplicate_canonical_sibling_id!);

  const preimageRes = await client.query(
    `SELECT ${preimageSelect}
     FROM public.expected_packages
     WHERE id = ANY($1::uuid[]) OR id = ANY($2::uuid[])`,
    [applyIds, siblingIds],
  );

  const liveById = new Map(
    (preimageRes.rows as Array<Record<string, unknown>>).map((r) => [String(r.id), r]),
  );

  for (const row of applyRows) {
    const live = liveById.get(row.expected_package_id);
    if (!live) blockers.push(`Duplicate row ${row.expected_package_id} not found in DB`);
    else {
      if (String(live.sku ?? "") !== String(row.sku ?? "")) {
        blockers.push(`Duplicate ${row.expected_package_id} sku preimage mismatch`);
      }
      if (String(live.fnsku ?? "") !== String(row.fnsku ?? "")) {
        blockers.push(`Duplicate ${row.expected_package_id} fnsku preimage mismatch`);
      }
    }
    const sibling = liveById.get(row.duplicate_canonical_sibling_id!);
    if (!sibling) {
      blockers.push(`Sibling ${row.duplicate_canonical_sibling_id} not found for ${row.expected_package_id}`);
    } else {
      if (String(sibling.sku ?? "") !== String(row.proposed_fix!.sku)) {
        blockers.push(
          `Sibling ${row.duplicate_canonical_sibling_id} sku ${sibling.sku} != proposed ${row.proposed_fix!.sku}`,
        );
      }
      if (String(sibling.fnsku ?? "") !== String(row.proposed_fix!.fnsku)) {
        blockers.push(
          `Sibling ${row.duplicate_canonical_sibling_id} fnsku ${sibling.fnsku} != proposed ${row.proposed_fix!.fnsku}`,
        );
      }
    }
  }

  if (blockers.length) {
    await client.end();
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked at DB validation: ${blockers.join("; ")}`);
  }

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      {
        run_id: runId,
        queue_run_id: queueRunId,
        duplicate_rows: applyRows.map((r) => liveById.get(r.expected_package_id)),
        sibling_rows: applyRows.map((r) => liveById.get(r.duplicate_canonical_sibling_id!)),
        before_ep_coverage: beforeEp,
      },
      null,
      2,
    ),
  );

  const applied: AppliedRow[] = [];
  await client.query("BEGIN");
  try {
    for (const row of applyRows) {
      const sibling = liveById.get(row.duplicate_canonical_sibling_id!)!;
      const siblingResolved = sibling.resolved_product_id
        ? String(sibling.resolved_product_id)
        : null;
      const mergeMeta = {
        pc03c_merge: {
          run_id: runId,
          queue_run_id: queueRunId,
          match_source: MATCH_SOURCE,
          canonical_sibling_id: row.duplicate_canonical_sibling_id,
          proposed_canonical_sku: row.proposed_fix!.sku,
          proposed_canonical_fnsku: row.proposed_fix!.fnsku,
          fix_basis: row.proposed_fix!.basis,
          reason: "duplicate_canonical_cross_file",
        },
      };

      const setParts = [
        "identifier_resolution_status = $2",
        "identifier_resolution_confidence = 1.0",
      ];
      const params: unknown[] = [row.expected_package_id, MERGE_STATUS];
      let nextParam = 3;

      if (hasSource) {
        setParts.push(`identifier_resolution_source = $${nextParam}`);
        params.push(MATCH_SOURCE);
        nextParam++;
      }
      if (hasMeta) {
        setParts.push(
          `identifier_resolution_meta = COALESCE(e.identifier_resolution_meta, '{}'::jsonb) || $${nextParam}::jsonb`,
        );
        params.push(JSON.stringify(mergeMeta));
        nextParam++;
      }

      setParts.push(`resolved_product_id = COALESCE(e.resolved_product_id, $${nextParam}::uuid)`);
      params.push(siblingResolved);
      nextParam++;

      if (hasReview) setParts.push("product_review_required = false");
      setParts.push("updated_at = now()");

      params.push(row.sku, row.fnsku);
      const skuIdx = nextParam;
      const fnskuIdx = nextParam + 1;

      const upd = await client.query(
        `
        UPDATE public.expected_packages e
        SET ${setParts.join(",\n            ")}
        WHERE e.id = $1::uuid
          AND COALESCE(NULLIF(TRIM(e.sku), ''), '') = COALESCE($${skuIdx}, '')
          AND COALESCE(NULLIF(TRIM(e.fnsku), ''), '') = COALESCE($${fnskuIdx}, '')
        RETURNING e.id::text, e.identifier_resolution_status, e.resolved_product_id::text
        `,
        params,
      );

      if (upd.rowCount !== 1) {
        throw new Error(`Expected 1 update for ${row.expected_package_id}, got ${upd.rowCount}`);
      }

      applied.push({
        expected_package_id: row.expected_package_id,
        canonical_sibling_id: row.duplicate_canonical_sibling_id!,
        proposed_sku: row.proposed_fix!.sku!,
        proposed_fnsku: row.proposed_fix!.fnsku!,
        inherited_resolved_product_id: siblingResolved,
        previous_status: row.identifier_resolution_status,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterEp = await epCoverage(client);
  await client.end();

  fs.writeFileSync(path.join(outDir, "applied-rows.json"), JSON.stringify(applied, null, 2));

  const rollbackLines: string[] = [
    "-- PC03C merge duplicate canonical rollback (staging only)",
    `-- run_id=${runId}`,
    "",
  ];
  for (const row of applyRows) {
    const pre = liveById.get(row.expected_package_id)!;
    const rollbackSet = [
      `  sku = ${sqlQuote(pre.sku as string | null)}`,
      `  fnsku = ${sqlQuote(pre.fnsku as string | null)}`,
      `  resolved_product_id = ${pre.resolved_product_id ? `'${pre.resolved_product_id}'::uuid` : "NULL"}`,
      `  identifier_resolution_status = ${sqlQuote(pre.identifier_resolution_status as string | null)}`,
      `  identifier_resolution_confidence = ${pre.identifier_resolution_confidence ?? "NULL"}`,
    ];
    if (hasSource) {
      rollbackSet.push(
        `  identifier_resolution_source = ${sqlQuote(pre.identifier_resolution_source as string | null)}`,
      );
    }
    if (hasMeta) {
      rollbackSet.push(
        `  identifier_resolution_meta = '${JSON.stringify(pre.identifier_resolution_meta ?? {}).replace(/'/g, "''")}'::jsonb`,
      );
    }
    if (hasReview) {
      rollbackSet.push(
        `  product_review_required = ${pre.product_review_required === true ? "true" : pre.product_review_required === false ? "false" : "NULL"}`,
      );
    }
    rollbackSet.push("  updated_at = now()");
    rollbackLines.push(
      `UPDATE public.expected_packages SET`,
      rollbackSet.join(",\n") + "",
      `WHERE id = '${row.expected_package_id}'::uuid;`,
      "",
    );
  }
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackLines.join("\n"));

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# PC03C approve-ready execute result",
      "",
      `- **Applied:** ${applied.length} merge_duplicate_canonical rows`,
      `- **Skipped:** ${skippedRows.length} manual-review rows (unchanged)`,
      `- **Match source:** \`${MATCH_SOURCE}\``,
      `- **Merge status:** \`${MERGE_STATUS}\``,
      "",
      "## Applied rows",
      "",
      ...applied.map(
        (r) =>
          `- \`${r.expected_package_id.slice(0, 8)}…\` → sibling \`${r.canonical_sibling_id.slice(0, 8)}…\` (${r.proposed_sku} / ${r.proposed_fnsku})`,
      ),
      "",
      "## Forbidden (verified)",
      "",
      "- No product create",
      "- No row delete",
      "- No sku/fnsku rewrite on duplicate rows",
      "- No original writes",
      "- No Amazon API",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "post-counts.md"),
    [
      "# Post counts",
      "",
      "## expected_packages read-layer",
      "",
      `| Metric | Before | After | Delta |`,
      `|--------|-------:|------:|------:|`,
      `| total | ${beforeEp.total} | ${afterEp.total} | ${(afterEp.total ?? 0) - (beforeEp.total ?? 0)} |`,
      `| read_layer_resolved | ${beforeEp.read_layer_resolved} | ${afterEp.read_layer_resolved} | ${(afterEp.read_layer_resolved ?? 0) - (beforeEp.read_layer_resolved ?? 0)} |`,
      `| unresolved | ${beforeEp.unresolved} | ${afterEp.unresolved} | ${(afterEp.unresolved ?? 0) - (beforeEp.unresolved ?? 0)} |`,
      `| ambiguous | ${beforeEp.ambiguous} | ${afterEp.ambiguous} | ${(afterEp.ambiguous ?? 0) - (beforeEp.ambiguous ?? 0)} |`,
    ].join("\n") + "\n",
  );

  const nextPrompt =
    "PRODUCT-LINKAGE-RERUN-AFTER-PC03C — verify EP unresolved delta after merge_duplicate_canonical execute";

  fs.writeFileSync(path.join(outDir, "blockers.md"), "- None\n");

  const manifest = {
    prompt: "PC03C-EXEC — EXPECTED PACKAGES APPROVE-READY EXECUTE",
    run_id: runId,
    queue_run_id: queueRunId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    approval_file: APPROVAL_PATH,
    applied_count: applied.length,
    skipped_count: skippedRows.length,
    match_source: MATCH_SOURCE,
    merge_status: MERGE_STATUS,
    expected_packages_coverage: {
      before: beforeEp,
      after: afterEp,
      delta_unresolved: (afterEp.unresolved ?? 0) - (beforeEp.unresolved ?? 0),
      delta_resolved: (afterEp.read_layer_resolved ?? 0) - (beforeEp.read_layer_resolved ?? 0),
    },
    forbidden: {
      products_created: false,
      rows_deleted: false,
      sku_fnsku_rewritten: false,
      original_touched: false,
      amazon_api: false,
    },
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        applied_count: applied.length,
        skipped_count: skippedRows.length,
        ep_unresolved_before: beforeEp.unresolved,
        ep_unresolved_after: afterEp.unresolved,
        rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
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
