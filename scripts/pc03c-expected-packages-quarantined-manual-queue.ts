/**
 * PC03C — EXPECTED PACKAGES QUARANTINED MANUAL QUEUE (read-only)
 *
 *   npx tsx scripts/pc03c-expected-packages-quarantined-manual-queue.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03c-expected-packages-quarantined-manual-queue.ts --exec-run-id=20260525T140000Z
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
const EXEC_DEFAULT = "20260525T140000Z";
const EXEC_BASE = ".cursor/audit-reports/pc03-exec-expected-packages-dirty-source-fix-execute";
const PLAN_BASE = ".cursor/audit-reports/pc03-expected-packages-dirty-source-quarantine-plan/20260523T050000Z";
const OUT_BASE = ".cursor/audit-reports/pc03c-expected-packages-quarantined-manual-queue";
const APPROVAL_MANUAL = ".cursor/operator-approvals/pc03c-expected-packages-manual-queue-execute-approval.md";
const APPROVAL_MERGE = ".cursor/operator-approvals/pc03c-expected-packages-merge-duplicate-canonical-approval.md";
const API404_DIR =
  ".cursor/audit-reports/expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z";

type QueueCohort = "quarantined_dirty_source" | "duplicate_canonical_skip" | "clean_manual";
type ActionCategory =
  | "approve_corrected_identifier"
  | "merge_duplicate_canonical"
  | "mark_invalid_source_error"
  | "requires_amazon_evidence"
  | "manual_product_match";

type QueueRow = {
  expected_package_id: string;
  cohort: QueueCohort;
  sku: string | null;
  fnsku: string | null;
  order_id: string | null;
  order_type: string | null;
  disposition: string | null;
  tracking_number: string | null;
  build_source: string | null;
  identifier_resolution_status: string | null;
  reason: string;
  dirty_reasons: string[];
  proposed_fix: { sku: string | null; fnsku: string | null; basis: string | null } | null;
  duplicate_canonical_sibling_id: string | null;
  product_candidates: Array<{
    product_id: string;
    sample_sku: string | null;
    sample_fnsku: string | null;
    sample_product_name: string | null;
    proof_source: string;
  }>;
  recommended_action: ActionCategory;
  approve_ready: boolean;
  notes: string;
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

function execRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--exec-run-id="));
  return a ? a.split("=")[1]!.trim() : EXEC_DEFAULT;
}

function loadApi404Ids(): Set<string> {
  const p = path.join(process.cwd(), API404_DIR, "execute-lines.json");
  if (!fs.existsSync(p)) return new Set();
  const lines = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{
    expected_package_ids: string[];
    outcome: string;
  }>;
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.outcome === "catalog_lookup_failed") {
      for (const id of line.expected_package_ids) ids.add(id);
    }
  }
  return ids;
}

function isDirty(sku: string | null, fnsku: string | null): boolean {
  const s = (sku ?? "").trim().toUpperCase();
  const f = (fnsku ?? "").trim().toUpperCase();
  if (/^(UNKNOWN|UNKNOW)$/i.test(s)) return true;
  if (/^B[0-9A-Z]{9}$/.test(f)) return true;
  return false;
}

function mergeCandidatesFromDirtyPlan(
  live: QueueRow["product_candidates"],
  dirty: Record<string, unknown> | undefined,
): QueueRow["product_candidates"] {
  const byId = new Map(live.map((c) => [c.product_id, c]));
  const proof = dirty?.inventory_proof as
    | {
        distinct_product_ids?: string[];
        sample_seller_sku?: string | null;
        sample_fnsku?: string | null;
        sample_product_name?: string | null;
        proof_sources?: string[];
      }
    | undefined;
  if (!proof?.distinct_product_ids?.length) return live;
  for (const pid of proof.distinct_product_ids) {
    if (!byId.has(pid)) {
      byId.set(pid, {
        product_id: pid,
        sample_sku: proof.sample_seller_sku ?? null,
        sample_fnsku: proof.sample_fnsku ?? null,
        sample_product_name: proof.sample_product_name ?? null,
        proof_source: (proof.proof_sources ?? ["dirty_plan.inventory_proof"]).join(","),
      });
    }
  }
  return [...byId.values()];
}

function classifyAction(
  row: Omit<QueueRow, "recommended_action" | "approve_ready" | "notes">,
  api404: Set<string>,
): { action: ActionCategory; approve_ready: boolean; notes: string } {
  if (row.cohort === "duplicate_canonical_skip") {
    return {
      action: "merge_duplicate_canonical",
      approve_ready: !!row.duplicate_canonical_sibling_id && !!row.proposed_fix?.sku,
      notes: row.duplicate_canonical_sibling_id
        ? `Sibling ${row.duplicate_canonical_sibling_id.slice(0, 8)}… holds canonical identifiers.`
        : "Sibling row already holds corrected canonical sku/fnsku; merge or dedupe import row.",
    };
  }
  if (row.cohort === "clean_manual") {
    return {
      action: "manual_product_match",
      approve_ready: false,
      notes: "Valid source identifiers but no map match — operator picks product + map insert.",
    };
  }
  if (api404.has(row.expected_package_id)) {
    return {
      action: "requires_amazon_evidence",
      approve_ready: false,
      notes: "Prior SP-API catalog lookup 404 for ASIN cohort.",
    };
  }
  const candidates = row.product_candidates;
  const uniqueProducts = [...new Set(candidates.map((c) => c.product_id))];
  if (row.cohort === "quarantined_dirty_source" && uniqueProducts.length === 1 && row.proposed_fix?.sku) {
    return {
      action: "approve_corrected_identifier",
      approve_ready: true,
      notes: "High-confidence inventory spine fix available; operator sign-off required.",
    };
  }
  if (uniqueProducts.length > 1) {
    return {
      action: "manual_product_match",
      approve_ready: false,
      notes: `Ambiguous inventory spine: ${uniqueProducts.length} distinct product_ids.`,
    };
  }
  if (
    row.cohort === "quarantined_dirty_source" &&
    /^X[0-9A-Z]{9,}$/.test((row.fnsku ?? "").trim()) &&
    !row.proposed_fix?.sku
  ) {
    return {
      action: "requires_amazon_evidence",
      approve_ready: false,
      notes: "X-FNSKU only; no unique inventory proof — validate in Seller Central / SP-API.",
    };
  }
  if (uniqueProducts.length === 0 && isDirty(row.sku, row.fnsku)) {
    return {
      action: "mark_invalid_source_error",
      approve_ready: false,
      notes: "Dirty identifiers with no inventory product proof.",
    };
  }
  return {
    action: "manual_product_match",
    approve_ready: false,
    notes: "Operator must pick product or correct source identifiers.",
  };
}

function writeApproval(relPath: string, title: string, flag: string, body: string): void {
  fs.writeFileSync(
    path.join(process.cwd(), relPath),
    `# ${title}

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product creation | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
${flag}=false
\`\`\`

${body}

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
${flag}=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execRunId = execRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const execDir = path.join(process.cwd(), EXEC_BASE, execRunId);
  const skippedDup = JSON.parse(
    fs.readFileSync(path.join(execDir, "skipped-duplicate-canonical.json"), "utf8"),
  ) as Array<{
    expected_package_id: string;
    current: { sku: string | null; fnsku: string | null };
    proposed: { sku: string | null; fnsku: string | null };
    fix_basis: string;
  }>;
  const quarantinedExec = JSON.parse(
    fs.readFileSync(path.join(execDir, "quarantined-rows.json"), "utf8"),
  ) as Array<{ id: string }>;
  const dirtyDetail = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), PLAN_BASE, "dirty-rows-detail.json"), "utf8"),
  ) as { rows: Array<Record<string, unknown>> };
  const dirtyById = new Map(dirtyDetail.rows.map((r) => [String(r.expected_package_id), r]));
  const api404 = loadApi404Ids();

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) throw new Error("Staging guard failed");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const dupIds = skippedDup.map((r) => r.expected_package_id);
  const quarantineIds = quarantinedExec.map((r) => r.id);

  const enrichRes = await client.query(
    `
    WITH unresolved AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku),'') AS sku, NULLIF(TRIM(e.fnsku),'') AS fnsku,
        NULLIF(TRIM(e.order_id),'') AS order_id,
        NULLIF(TRIM(e.order_type),'') AS order_type,
        NULLIF(TRIM(e.disposition),'') AS disposition,
        NULLIF(TRIM(e.tracking_number),'') AS tracking_number,
        NULLIF(TRIM(e.build_source),'') AS build_source,
        e.identifier_resolution_status,
        CASE
          WHEN e.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN EXISTS (
            SELECT 1 FROM public.product_identifier_map m
            WHERE m.organization_id=e.organization_id AND m.store_id=e.store_id
              AND m.deleted_at IS NULL AND e.fnsku IS NOT NULL AND m.fnsku=e.fnsku
          ) OR EXISTS (
            SELECT 1 FROM public.product_identifier_map m
            WHERE m.organization_id=e.organization_id AND m.store_id=e.store_id
              AND m.deleted_at IS NULL AND e.sku IS NOT NULL
              AND (m.seller_sku=e.sku OR m.msku=e.sku)
          ) THEN 'resolved'
          ELSE 'unresolved'
        END AS read_bucket
      FROM public.expected_packages e
    ),
    queue AS (
      SELECT * FROM unresolved u
      WHERE u.read_bucket = 'unresolved'
        AND (
          u.identifier_resolution_status = 'quarantined_dirty_source'
          OR u.id = ANY($1::uuid[])
          OR u.id = ANY($2::uuid[])
          OR (
            u.identifier_resolution_status IS DISTINCT FROM 'quarantined_dirty_source'
            AND NOT (UPPER(COALESCE(u.sku,'')) IN ('UNKNOW','UNKNOWN'))
            AND NOT (COALESCE(u.fnsku,'') ~ '^B[0-9A-Z]{9}$')
          )
        )
    ),
    inv AS (
      SELECT q.id AS ep_id, x.product_id::text, x.sample_sku, x.sample_fnsku, x.sample_name, x.proof_source
      FROM queue q
      CROSS JOIN LATERAL (
        SELECT COALESCE(f.resolved_product_id, f.product_id) AS product_id,
          NULLIF(TRIM(f.sku),'') AS sample_sku, NULLIF(TRIM(f.fnsku),'') AS sample_fnsku,
          NULLIF(TRIM(f.product_name),'') AS sample_name, 'inventory.fnsku'::text AS proof_source
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id=q.organization_id AND f.store_id=q.store_id
          AND q.fnsku IS NOT NULL AND f.fnsku=q.fnsku
          AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        UNION ALL
        SELECT COALESCE(f.resolved_product_id, f.product_id),
          NULLIF(TRIM(f.sku),''), NULLIF(TRIM(f.fnsku),''), NULLIF(TRIM(f.product_name),''),
          'inventory.asin'
        FROM public.amazon_fba_inventory f
        WHERE q.fnsku ~ '^B[0-9A-Z]{9}$' AND f.organization_id=q.organization_id AND f.store_id=q.store_id
          AND NULLIF(TRIM(f.asin),'') = q.fnsku
          AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        UNION ALL
        SELECT COALESCE(mf.resolved_product_id, mf.product_id),
          NULLIF(TRIM(mf.sku),''), NULLIF(TRIM(mf.fnsku),''), NULLIF(TRIM(mf.product_name),''),
          'manage_fba.fnsku'
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id=q.organization_id AND mf.store_id=q.store_id
          AND q.fnsku IS NOT NULL AND mf.fnsku=q.fnsku
          AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
      ) x
    ),
    inv_agg AS (
      SELECT ep_id,
        json_agg(json_build_object(
          'product_id', product_id,
          'sample_sku', sample_sku,
          'sample_fnsku', sample_fnsku,
          'sample_product_name', sample_name,
          'proof_source', proof_source
        )) AS candidates
      FROM inv
      GROUP BY ep_id
    )
    SELECT q.*, COALESCE(ia.candidates, '[]'::json) AS product_candidates
    FROM queue q
    LEFT JOIN inv_agg ia ON ia.ep_id = q.id
    ORDER BY q.identifier_resolution_status NULLS LAST, q.fnsku, q.sku, q.id
  `,
    [dupIds, quarantineIds],
  );

  const siblingRes = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        expected_package_id uuid, proposed_sku text, proposed_fnsku text
      )
    ),
    src AS (
      SELECT i.expected_package_id, i.proposed_sku, i.proposed_fnsku,
        e.organization_id, e.store_id, e.order_id, e.order_type, e.disposition
      FROM input i
      JOIN public.expected_packages e ON e.id = i.expected_package_id
    )
    SELECT s.expected_package_id::text, e2.id::text AS sibling_id
    FROM src s
    JOIN public.expected_packages e2
      ON e2.organization_id = s.organization_id AND e2.store_id = s.store_id
     AND e2.order_id IS NOT DISTINCT FROM s.order_id
     AND e2.order_type IS NOT DISTINCT FROM s.order_type
     AND e2.disposition IS NOT DISTINCT FROM s.disposition
     AND COALESCE(NULLIF(TRIM(e2.sku), ''), '') = COALESCE(s.proposed_sku, '')
     AND COALESCE(NULLIF(TRIM(e2.fnsku), ''), '') = COALESCE(s.proposed_fnsku, '')
     AND e2.id IS DISTINCT FROM s.expected_package_id
    `,
    [
      JSON.stringify(
        skippedDup.map((r) => ({
          expected_package_id: r.expected_package_id,
          proposed_sku: r.proposed.sku,
          proposed_fnsku: r.proposed.fnsku,
        })),
      ),
    ],
  );
  await client.end();

  const siblingByEp = new Map<string, string>();
  for (const r of siblingRes.rows as Array<{ expected_package_id: string; sibling_id: string }>) {
    siblingByEp.set(r.expected_package_id, r.sibling_id);
  }

  const dupSet = new Set(dupIds);
  const quarantineSet = new Set(quarantineIds);

  const queue: QueueRow[] = [];
  for (const r of enrichRes.rows as Record<string, unknown>[]) {
    const epId = String(r.id);
    let cohort: QueueCohort = "clean_manual";
    if (dupSet.has(epId)) cohort = "duplicate_canonical_skip";
    else if (
      r.identifier_resolution_status === "quarantined_dirty_source" ||
      quarantineSet.has(epId)
    ) {
      cohort = "quarantined_dirty_source";
    }

    const dirty = dirtyById.get(epId);
    const dirtyReasons = Array.isArray(dirty?.dirty_reasons)
      ? (dirty.dirty_reasons as string[])
      : [];
    const dupPlan = skippedDup.find((d) => d.expected_package_id === epId);
    const proposed =
      dupPlan != null
        ? { sku: dupPlan.proposed.sku, fnsku: dupPlan.proposed.fnsku, basis: dupPlan.fix_basis }
        : dirty?.proposed_fix
          ? {
              sku: (dirty.proposed_fix as { sku?: string }).sku ?? null,
              fnsku: (dirty.proposed_fix as { fnsku?: string }).fnsku ?? null,
              basis: (dirty.proposed_fix as { fix_basis?: string }).fix_basis ?? null,
            }
          : null;

    const liveCandidates = (typeof r.product_candidates === "string"
      ? JSON.parse(r.product_candidates)
      : r.product_candidates ?? []) as QueueRow["product_candidates"];
    const candidates = mergeCandidatesFromDirtyPlan(liveCandidates, dirty);

    const base: Omit<QueueRow, "recommended_action" | "approve_ready" | "notes"> = {
      expected_package_id: epId,
      cohort,
      sku: r.sku ? String(r.sku) : null,
      fnsku: r.fnsku ? String(r.fnsku) : null,
      order_id: r.order_id ? String(r.order_id) : null,
      order_type: r.order_type ? String(r.order_type) : null,
      disposition: r.disposition ? String(r.disposition) : null,
      tracking_number: r.tracking_number ? String(r.tracking_number) : null,
      build_source: r.build_source ? String(r.build_source) : null,
      identifier_resolution_status: r.identifier_resolution_status
        ? String(r.identifier_resolution_status)
        : null,
      reason:
        cohort === "duplicate_canonical_skip"
          ? "duplicate_canonical_cross_file"
          : cohort === "quarantined_dirty_source"
            ? "quarantined_dirty_source"
            : "clean_identifier_no_map",
      dirty_reasons: dirtyReasons,
      proposed_fix: proposed,
      duplicate_canonical_sibling_id: siblingByEp.get(epId) ?? null,
      product_candidates: candidates,
    };
    const { action, approve_ready, notes } = classifyAction(base, api404);
    queue.push({ ...base, recommended_action: action, approve_ready, notes });
  }

  const byAction = new Map<ActionCategory, number>();
  for (const row of queue) byAction.set(row.recommended_action, (byAction.get(row.recommended_action) ?? 0) + 1);

  fs.writeFileSync(path.join(outDir, "manual-review-queue.json"), JSON.stringify({ run_id: runId, queue }, null, 2));

  const md = [
    "# Expected packages manual review queue",
    "",
    `**Run id:** \`${runId}\` | **Exec ref:** \`${EXEC_BASE}/${execRunId}\``,
    `**Branch:** \`${branch}\``,
    "",
    "## Summary",
    "",
    `- **Total queue rows:** ${queue.length}`,
    `- quarantined_dirty_source: ${queue.filter((r) => r.cohort === "quarantined_dirty_source").length}`,
    `- duplicate_canonical_skip: ${queue.filter((r) => r.cohort === "duplicate_canonical_skip").length}`,
    `- clean_manual: ${queue.filter((r) => r.cohort === "clean_manual").length}`,
    `- **Approve-ready:** ${queue.filter((r) => r.approve_ready).length}`,
    `- requires_amazon_evidence: ${byAction.get("requires_amazon_evidence") ?? 0}`,
    `- manual_product_match: ${byAction.get("manual_product_match") ?? 0}`,
    "",
    "## Action categories",
    "",
    ...[
      "approve_corrected_identifier",
      "merge_duplicate_canonical",
      "mark_invalid_source_error",
      "requires_amazon_evidence",
      "manual_product_match",
    ].map((a) => `- **${a}:** ${byAction.get(a as ActionCategory) ?? 0}`),
    "",
    "## Queue",
    "",
    "| cohort | ep_id | sku | fnsku | order_id | action | approve_ready | candidates |",
    "|--------|-------|-----|-------|----------|--------|:-------------:|-----------:|",
    ...queue.map(
      (r) =>
        `| ${r.cohort} | \`${r.expected_package_id.slice(0, 8)}…\` | ${r.sku ?? "—"} | ${r.fnsku ?? "—"} | ${r.order_id ?? "—"} | ${r.recommended_action} | ${r.approve_ready ? "yes" : "no"} | ${r.product_candidates.length} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "manual-review-queue.md"), `${md}\n`);

  fs.writeFileSync(
    path.join(outDir, "action-category-matrix.md"),
    [
      "# Action category matrix",
      "",
      "| Action | Count | Typical next step |",
      "|--------|------:|-------------------|",
      `| approve_corrected_identifier | ${byAction.get("approve_corrected_identifier") ?? 0} | Governed source UPDATE + map-only |`,
      `| merge_duplicate_canonical | ${byAction.get("merge_duplicate_canonical") ?? 0} | Dedupe/merge with sibling row |`,
      `| mark_invalid_source_error | ${byAction.get("mark_invalid_source_error") ?? 0} | Exclude from linkage waves |`,
      `| requires_amazon_evidence | ${byAction.get("requires_amazon_evidence") ?? 0} | SP-API / Seller Central validation |`,
      `| manual_product_match | ${byAction.get("manual_product_match") ?? 0} | Operator PIM pick + map insert |`,
    ].join("\n") + "\n",
  );

  const approveReady = queue.filter((r) => r.approve_ready);
  writeApproval(
    APPROVAL_MANUAL,
    "PC03C expected packages manual queue execute",
    "APPROVED_PC03C_EXPECTED_PACKAGES_MANUAL_QUEUE_EXECUTE",
    `## Scope\n\n- Queue rows: **${queue.length}**\n- Approve-ready: **${approveReady.length}**\n- Plan: \`${OUT_BASE}/${runId}/\``,
  );
  writeApproval(
    APPROVAL_MERGE,
    "PC03C merge duplicate canonical execute",
    "APPROVED_PC03C_EXPECTED_PACKAGES_MERGE_DUPLICATE_CANONICAL",
    `## Scope\n\n- Duplicate-canonical rows: **${queue.filter((r) => r.cohort === "duplicate_canonical_skip").length}**\n- Allowed: mark duplicate / merge lineage only; no product create`,
  );

  fs.writeFileSync(
    path.join(outDir, "approval-files.md"),
    [
      "# Approval files (default false)",
      "",
      `| File | Purpose |`,
      `|------|---------|`,
      `| \`${APPROVAL_MANUAL}\` | manual queue governed writes |`,
      `| \`${APPROVAL_MERGE}\` | duplicate canonical merge/dedupe |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md",
    ),
    [
      "# Blockers",
      "",
      "- Read-only queue; no DB writes.",
      `- ${queue.filter((r) => r.recommended_action === "manual_product_match").length} rows need operator product pick.`,
      `- ${queue.filter((r) => !r.approve_ready).length} rows not approve-ready.`,
      "- SP-API evidence gated separately.",
    ].join("\n") + "\n",
  );

  const nextPrompt =
    approveReady.length > 0
      ? "PC03C-EXEC — EXPECTED-PACKAGES-MANUAL-QUEUE-APPROVE-READY-EXECUTE"
      : "PC03C — EXPECTED-PACKAGES-MANUAL-PRODUCT-MATCH-OPERATOR-SESSION";

  fs.writeFileSync(
    path.join(outDir, "execute-prompts-next.md",
    ),
    `# Next execute prompts\n\n1. Review \`manual-review-queue.json\`\n2. **${nextPrompt}**\n`,
  );

  const manifest = {
    prompt: "PC03C — EXPECTED PACKAGES QUARANTINED MANUAL QUEUE",
    run_id: runId,
    exec_run_id: execRunId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    queue_count: queue.length,
    cohort_counts: {
      quarantined_dirty_source: queue.filter((r) => r.cohort === "quarantined_dirty_source").length,
      duplicate_canonical_skip: queue.filter((r) => r.cohort === "duplicate_canonical_skip").length,
      clean_manual: queue.filter((r) => r.cohort === "clean_manual").length,
    },
    approve_ready_count: approveReady.length,
    requires_amazon_evidence_count: byAction.get("requires_amazon_evidence") ?? 0,
    manual_product_match_count: byAction.get("manual_product_match") ?? 0,
    action_categories: Object.fromEntries([...byAction.entries()]),
    approval_files: [APPROVAL_MANUAL, APPROVAL_MERGE],
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
