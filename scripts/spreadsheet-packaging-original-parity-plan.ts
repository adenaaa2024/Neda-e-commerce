/**
 * SPREADSHEET PACKAGING ORIGINAL PARITY PLAN — read-only staging vs original comparison.
 *
 *   npx tsx scripts/spreadsheet-packaging-original-parity-plan.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const BATCH_TAG = "SPREADSHEET_DIMENSIONS_20260528T010000Z";
const EXECUTE_RUN = "20260528T030000Z";
const REVIEW_RUN = "20260528T040000Z";
const ACTIVATE_RUN = "20260528T050000Z";
const EXPECTED_ACTIVATED = 80;
const EXPECTED_STAGING_CURRENT_AFTER = 571;
const APPROVAL_REL = ".cursor/operator-approvals/spreadsheet-packaging-original-parity-approval.md";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-packaging-original-parity-plan";

type PackagingRow = {
  candidate_id: string;
  organization_id: string;
  store_id: string | null;
  product_id: string;
  packaging_level: string;
  fulfillment_context: string;
  profile_id: string;
  version_id: string;
  profile_status: string;
  length_value: number | null;
  width_value: number | null;
  height_value: number | null;
  dimension_unit: string | null;
  weight_value: number | null;
  weight_unit: string | null;
  units_per_inner_pack: number | null;
  units_per_case: number | null;
  source_type: string;
  source_reference: string | null;
  confidence_score: number | null;
  evidence_summary: Record<string, unknown>;
  display_label: string | null;
  has_current: boolean;
};

type Classification = "already_present" | "missing" | "conflict" | "unsafe";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function profileKey(
  org: string,
  store: string | null,
  product: string,
  level: string,
  context: string,
): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dimsMatch(a: PackagingRow, b: PackagingRow): boolean {
  const fields: (keyof PackagingRow)[] = [
    "length_value",
    "width_value",
    "height_value",
    "dimension_unit",
    "weight_value",
    "weight_unit",
    "units_per_inner_pack",
    "units_per_case",
  ];
  return fields.every((f) => {
    const av = a[f];
    const bv = b[f];
    if (av == null && bv == null) return true;
    if (typeof av === "number" && typeof bv === "number") return Math.abs(av - bv) < 0.0001;
    return av === bv;
  });
}

async function fetchSpreadsheetActivatedStaging(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       COALESCE(v.evidence_summary->>'spreadsheet_candidate_id', v.evidence_summary->>'spreadsheet_row') AS candidate_id,
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context, p.display_label,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score, v.evidence_summary,
       c.current_version_id::text AS current_version_id
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE p.display_label = $1
       AND v.profile_status = 'active'
       AND (v.effective_to IS NULL OR v.effective_to > now())
       AND c.current_version_id = v.id`,
    [BATCH_TAG],
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const cid =
      String(row.candidate_id ?? "").trim() ||
      `spreadsheet-row-${String((row.evidence_summary as Record<string, unknown>)?.spreadsheet_row ?? "")}`;
    if (!cid) continue;
    out.set(cid, {
      candidate_id: cid,
      organization_id: String(row.organization_id),
      store_id: row.store_id ? String(row.store_id) : null,
      product_id: String(row.product_id),
      packaging_level: String(row.packaging_level),
      fulfillment_context: String(row.fulfillment_context),
      profile_id: String(row.profile_id),
      version_id: String(row.version_id),
      profile_status: String(row.profile_status),
      length_value: num(row.length_value),
      width_value: num(row.width_value),
      height_value: num(row.height_value),
      dimension_unit: row.dimension_unit ? String(row.dimension_unit) : null,
      weight_value: num(row.weight_value),
      weight_unit: row.weight_unit ? String(row.weight_unit) : null,
      units_per_inner_pack: num(row.units_per_inner_pack),
      units_per_case: num(row.units_per_case),
      source_type: String(row.source_type),
      source_reference: row.source_reference ? String(row.source_reference) : null,
      confidence_score: num(row.confidence_score),
      evidence_summary: (row.evidence_summary as Record<string, unknown>) ?? {},
      display_label: row.display_label ? String(row.display_label) : null,
      has_current: true,
    });
  }
  return out;
}

async function fetchOriginalByKey(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score, v.evidence_summary,
       c.current_version_id::text AS current_version_id
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE v.profile_status = 'active' AND (v.effective_to IS NULL OR v.effective_to > now())`,
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const key = profileKey(
      String(row.organization_id),
      row.store_id ? String(row.store_id) : null,
      String(row.product_id),
      String(row.packaging_level),
      String(row.fulfillment_context),
    );
    out.set(key, {
      candidate_id: "",
      organization_id: String(row.organization_id),
      store_id: row.store_id ? String(row.store_id) : null,
      product_id: String(row.product_id),
      packaging_level: String(row.packaging_level),
      fulfillment_context: String(row.fulfillment_context),
      profile_id: String(row.profile_id),
      version_id: String(row.version_id),
      profile_status: String(row.profile_status),
      length_value: num(row.length_value),
      width_value: num(row.width_value),
      height_value: num(row.height_value),
      dimension_unit: row.dimension_unit ? String(row.dimension_unit) : null,
      weight_value: num(row.weight_value),
      weight_unit: row.weight_unit ? String(row.weight_unit) : null,
      units_per_inner_pack: num(row.units_per_inner_pack),
      units_per_case: num(row.units_per_case),
      source_type: String(row.source_type),
      source_reference: row.source_reference ? String(row.source_reference) : null,
      confidence_score: num(row.confidence_score),
      evidence_summary: (row.evidence_summary as Record<string, unknown>) ?? {},
      display_label: null,
      has_current:
        row.profile_status === "active" &&
        !!row.current_version_id &&
        String(row.current_version_id) === String(row.version_id),
    });
  }
  return out;
}

async function productsExistOnOriginal(client: pg.Client, productIds: string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const r = await client.query(
    `SELECT id::text FROM public.products WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [productIds],
  );
  return new Set(r.rows.map((x: { id: string }) => x.id));
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = refFromConnectionUrl(stagingUrl) || getStagingProjectRef({ loadEnv: false });
  const originalRef = refFromConnectionUrl(originalUrl);

  const activateManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/spreadsheet-packaging-activate-staging",
    ACTIVATE_RUN,
    "manifest.json",
  );

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl || !originalUrl) blockers.push("Missing postgres URLs");
  if (stagingUrl === originalUrl) blockers.push("URLs must differ");

  const activateOk =
    fs.existsSync(activateManifestPath) &&
    (() => {
      try {
        const m = JSON.parse(fs.readFileSync(activateManifestPath, "utf8")) as {
          ok?: boolean;
          activated_count?: number;
          dimensions_current_after?: number;
        };
        return (
          m.ok === true &&
          (m.activated_count ?? 0) === EXPECTED_ACTIVATED &&
          (m.dimensions_current_after ?? 0) === EXPECTED_STAGING_CURRENT_AFTER
        );
      } catch {
        return false;
      }
    })();
  if (!activateOk) {
    blockers.push(`Spreadsheet activate proof required: ${ACTIVATE_RUN} (80 active, dimensions_current=571)`);
  }

  const diffRows: {
    candidate_id: string;
    composite_key: string;
    classification: Classification;
    reason: string;
    staging_profile_id: string | null;
    original_profile_id: string | null;
  }[] = [];

  let stagingBatch = new Map<string, PackagingRow>();
  let stagingCounts = { current: 0 };
  let originalCounts = { profiles: 0, versions: 0, current: 0 };

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    stagingBatch = await fetchSpreadsheetActivatedStaging(stagingClient);
    if (stagingBatch.size !== EXPECTED_ACTIVATED) {
      blockers.push(
        `Expected ${EXPECTED_ACTIVATED} activated spreadsheet rows on staging, got ${stagingBatch.size}`,
      );
    }

    const sc = await stagingClient.query(
      `SELECT count(*)::int c FROM public.product_packaging_dimensions_current`,
    );
    stagingCounts.current = Number(sc.rows[0]?.c ?? 0);
    if (stagingCounts.current !== EXPECTED_STAGING_CURRENT_AFTER) {
      blockers.push(
        `Staging dimensions_current ${stagingCounts.current}, expected ${EXPECTED_STAGING_CURRENT_AFTER}`,
      );
    }

    const originalByKey = await fetchOriginalByKey(originalClient);
    const oc = await originalClient.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
    );
    originalCounts = oc.rows[0] as typeof originalCounts;

    const productIds = [...new Set([...stagingBatch.values()].map((r) => r.product_id))];
    const productsOnOriginal = await productsExistOnOriginal(originalClient, productIds);

    for (const staging of stagingBatch.values()) {
      const composite = profileKey(
        staging.organization_id,
        staging.store_id,
        staging.product_id,
        staging.packaging_level,
        staging.fulfillment_context,
      );

      let classification: Classification = "missing";
      let reason = "";

      if (!productsOnOriginal.has(staging.product_id)) {
        classification = "unsafe";
        reason = "product_id_not_on_original";
      } else {
        const orig = originalByKey.get(composite) ?? null;
        if (!orig) {
          classification = "missing";
          reason = "no_matching_active_profile_on_original";
        } else if (!dimsMatch(staging, orig) || staging.profile_status !== orig.profile_status) {
          classification = "conflict";
          reason = !dimsMatch(staging, orig) ? "dimension_or_unit_mismatch" : "status_mismatch";
        } else if (orig.has_current) {
          classification = "already_present";
          reason = "active_with_matching_current";
        } else {
          classification = "missing";
          reason = "original_profile_without_current_snapshot";
        }
      }

      diffRows.push({
        candidate_id: staging.candidate_id,
        composite_key: composite,
        classification,
        reason,
        staging_profile_id: staging.profile_id,
        original_profile_id:
          classification === "already_present" || classification === "conflict"
            ? (originalByKey.get(composite)?.profile_id ?? null)
            : null,
      });
    }

    await stagingClient.end();
    await originalClient.end();
  }

  const counts = {
    activated_staging_rows: stagingBatch.size,
    already_present: diffRows.filter((d) => d.classification === "already_present").length,
    missing: diffRows.filter((d) => d.classification === "missing").length,
    conflict: diffRows.filter((d) => d.classification === "conflict").length,
    unsafe: diffRows.filter((d) => d.classification === "unsafe").length,
  };

  const insertPlan = diffRows
    .filter((d) => d.classification === "missing")
    .map((d) => {
      const s = stagingBatch.get(d.candidate_id)!;
      return {
        candidate_id: d.candidate_id,
        composite_key: d.composite_key,
        organization_id: s.organization_id,
        store_id: s.store_id,
        product_id: s.product_id,
        packaging_level: s.packaging_level,
        fulfillment_context: s.fulfillment_context,
        profile_status: "active",
        length_value: s.length_value,
        width_value: s.width_value,
        height_value: s.height_value,
        dimension_unit: s.dimension_unit,
        weight_value: s.weight_value,
        weight_unit: s.weight_unit,
        units_per_inner_pack: s.units_per_inner_pack,
        units_per_case: s.units_per_case,
        source_type: s.source_type,
        source_reference: s.source_reference,
        confidence_score: s.confidence_score,
        evidence_summary: {
          ...s.evidence_summary,
          spreadsheet_original_plan_run_id: runId,
          spreadsheet_candidate_id: d.candidate_id,
          mirrored_from: STAGING_REF,
          spreadsheet_execute_run: EXECUTE_RUN,
          spreadsheet_review_run: REVIEW_RUN,
          spreadsheet_activate_run: ACTIVATE_RUN,
          batch_tag: BATCH_TAG,
        },
        display_label: `SPREADSHEET_ORIGINAL_${runId}`,
        recommended_action: "insert_active_profile_and_version_on_original",
      };
    });

  const conflicts = diffRows.filter((d) => d.classification === "conflict");
  const unsafe = diffRows.filter((d) => d.classification === "unsafe");

  const nextPrompt =
    counts.conflict > 0 || counts.unsafe > 0
      ? "SPREADSHEET-PACKAGING-ORIGINAL-PARITY-RESOLVE — triage conflict/unsafe rows before execute"
      : counts.missing > 0
        ? "SPREADSHEET-PACKAGING-ORIGINAL-PARITY-EXECUTE — governed insert on original after approval"
        : "SPREADSHEET-PACKAGING-ORIGINAL-PARITY-NOOP — all 80 rows already present on original";

  fs.writeFileSync(
    path.join(outDir, "spreadsheet-original-parity-plan.md"),
    [
      "# Spreadsheet packaging original parity plan (read-only)",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging:** \`${STAGING_REF}\` — activated spreadsheet batch only`,
      `**Original:** \`${ORIGINAL_REF}\` — **no writes this run**`,
      "",
      "## Cohort",
      "",
      `- Batch tag: \`${BATCH_TAG}\``,
      `- Import execute: \`${EXECUTE_RUN}\``,
      `- Review census: \`${REVIEW_RUN}\``,
      `- Staging activate: \`${ACTIVATE_RUN}\``,
      "",
      "## Environment totals",
      "",
      "| Env | dimensions_current |",
      "|-----|-------------------:|",
      `| Staging | ${stagingCounts.current} |`,
      `| Original (now) | ${originalCounts.current} |`,
      "",
      "## Classification (80 activated staging rows)",
      "",
      "| Class | Count |",
      "|-------|------:|",
      `| already_present | ${counts.already_present} |`,
      `| **missing** | **${counts.missing}** |`,
      `| conflict | ${counts.conflict} |`,
      `| unsafe | ${counts.unsafe} |`,
      "",
      `**Original insert plan rows:** ${insertPlan.length} (missing only)`,
      "",
      "## Next",
      "",
      nextPrompt,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-diff.json"),
    JSON.stringify(
      {
        run_id: runId,
        batch_tag: BATCH_TAG,
        counts,
        rows: diffRows,
        staging_dimensions_current: stagingCounts.current,
        original_table_counts: originalCounts,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(outDir, "original-insert-plan.json"), JSON.stringify(insertPlan, null, 2));

  fs.writeFileSync(
    path.join(outDir, "conflict-report.md"),
    [
      "# Conflict / unsafe report",
      "",
      `Conflicts: **${conflicts.length}** | Unsafe: **${unsafe.length}**`,
      "",
      conflicts.length
        ? conflicts.map((c) => `- \`${c.candidate_id}\`: ${c.reason}`).join("\n")
        : "No conflicts.",
      "",
      unsafe.length ? unsafe.map((c) => `- \`${c.candidate_id}\`: ${c.reason}`).join("\n") : "No unsafe rows.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_REL}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_ORIGINAL=false",
      "APPROVED_SPREADSHEET_PACKAGING_ORIGINAL_PARITY=false",
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md"),
    [
      "# Rollback plan (future execute)",
      "",
      "```sql",
      `-- DELETE profiles inserted with display_label LIKE 'SPREADSHEET_ORIGINAL_${runId}%';`,
      "-- Use execute-run preimage when available.",
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.");

  const ok =
    blockers.length === 0 &&
    counts.activated_staging_rows === EXPECTED_ACTIVATED &&
    counts.conflict === 0 &&
    counts.unsafe === 0;

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET PACKAGING ORIGINAL PARITY PLAN",
        run_id: runId,
        branch,
        batch_tag: BATCH_TAG,
        execute_run_id: EXECUTE_RUN,
        review_run_id: REVIEW_RUN,
        activate_run_id: ACTIVATE_RUN,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        counts,
        insert_plan_rows: insertPlan.length,
        staging_dimensions_current: stagingCounts.current,
        original_dimensions_current: originalCounts.current,
        read_only: true,
        no_original_writes: true,
        next_prompt: nextPrompt,
        ok,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok,
        output_directory: outDir,
        counts,
        insert_plan_rows: insertPlan.length,
        next_prompt: nextPrompt,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : blockers.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
