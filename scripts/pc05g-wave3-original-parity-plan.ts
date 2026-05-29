/**
 * PC05G — Wave 3 activated rows original parity plan (read-only).
 *
 *   npx tsx scripts/pc05g-wave3-original-parity-plan.ts
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
const WAVE3_EXECUTE_RUN = "20260527T120000Z";
const WAVE3_ACTIVATE_RUN = "20260526T194000Z";
const EXPECTED_ACTIVATED = 50;
const EXPECTED_STAGING_CURRENT_AFTER = 491;
const EXPECTED_ORIGINAL_CURRENT_AFTER = 491;
const BATCH_TAG = `PC05D_WAVE3_${WAVE3_EXECUTE_RUN}`;
const APPROVAL_REL = ".cursor/operator-approvals/product-packaging-wave3-original-parity-pc05g-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc05g-wave3-original-parity-plan";

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

function profileKey(org: string, store: string | null, product: string, level: string, context: string): string {
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

function approvalFileContent(): string {
  return `# Product packaging Wave 3 — original parity (PC05G)

**Default:** not approved until plan review.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Staging source | Wave 3 activated cohort only (\`${BATCH_TAG}\`) |
| Scope | 50 activated PIM case-pack rows — excludes pilot + Wave 1 + Wave 2 |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

async function fetchWave3ActivatedStaging(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
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
       AND v.effective_to IS NULL
       AND c.current_version_id = v.id`,
    [BATCH_TAG],
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const cid = String(row.candidate_id ?? "");
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
     WHERE v.profile_status = 'active' AND v.effective_to IS NULL`,
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

  const activateManifest = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05-wave3-activate-staging",
    WAVE3_ACTIVATE_RUN,
    "manifest.json",
  );

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl || !originalUrl) blockers.push("Missing postgres URLs");
  if (stagingUrl === originalUrl) blockers.push("URLs must differ");

  const activateOk =
    fs.existsSync(activateManifest) &&
    (() => {
      try {
        const m = JSON.parse(fs.readFileSync(activateManifest, "utf8")) as {
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
  if (!activateOk) blockers.push(`Wave3 activate proof required: ${WAVE3_ACTIVATE_RUN}`);

  const approvalPath = path.join(process.cwd(), APPROVAL_REL);
  if (!fs.existsSync(approvalPath)) {
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    fs.writeFileSync(approvalPath, approvalFileContent());
  }

  const diffRows: {
    candidate_id: string;
    composite_key: string;
    classification: Classification;
    reason: string;
    staging_profile_id: string | null;
    original_profile_id: string | null;
  }[] = [];

  let stagingWave3 = new Map<string, PackagingRow>();
  let stagingCounts = { current: 0 };
  let originalCounts = { profiles: 0, versions: 0, current: 0 };

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    stagingWave3 = await fetchWave3ActivatedStaging(stagingClient);
    if (stagingWave3.size !== EXPECTED_ACTIVATED) {
      blockers.push(`Expected ${EXPECTED_ACTIVATED} activated Wave3 rows on staging, got ${stagingWave3.size}`);
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

    const productIds = [...new Set([...stagingWave3.values()].map((r) => r.product_id))];
    const productsOnOriginal = await productsExistOnOriginal(originalClient, productIds);

    for (const staging of stagingWave3.values()) {
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
    activated_staging_rows: stagingWave3.size,
    already_present: diffRows.filter((d) => d.classification === "already_present").length,
    missing: diffRows.filter((d) => d.classification === "missing").length,
    conflict: diffRows.filter((d) => d.classification === "conflict").length,
    unsafe: diffRows.filter((d) => d.classification === "unsafe").length,
  };

  const insertPlan = diffRows
    .filter((d) => d.classification === "missing")
    .map((d) => {
      const s = stagingWave3.get(d.candidate_id)!;
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
          pc05g_wave3_original_plan_run_id: runId,
          pc05_candidate_id: d.candidate_id,
          mirrored_from: STAGING_REF,
          wave3_execute_run: WAVE3_EXECUTE_RUN,
          wave3_activate_run: WAVE3_ACTIVATE_RUN,
        },
        display_label: `PC05G_WAVE3_ORIGINAL_<run_id>`,
      };
    });

  const conflicts = diffRows.filter((d) => d.classification === "conflict");
  const unsafe = diffRows.filter((d) => d.classification === "unsafe");

  fs.writeFileSync(
    path.join(outDir, "wave3-original-parity-plan.md"),
    [
      "# Wave 3 original parity plan — PC05G (plan only)",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging:** \`${STAGING_REF}\` — activated Wave 3 only`,
      `**Original:** \`${ORIGINAL_REF}\` — no writes this run`,
      "",
      "## Cohort definition",
      "",
      `- Batch tag: \`${BATCH_TAG}\``,
      `- Status: \`active\` with \`dimensions_current\` snapshot`,
      `- Wave3 execute: \`${WAVE3_EXECUTE_RUN}\` | activate: \`${WAVE3_ACTIVATE_RUN}\``,
      "- Excludes 191 pilot + 50 Wave 1 + 200 Wave 2",
      "",
      "## Table totals (context)",
      "",
      "| Env | dimensions_current |",
      "|-----|-------------------:|",
      `| Staging | ${stagingCounts.current} |`,
      `| Original (now) | ${originalCounts.current} |`,
      `| Original (after execute) | **${EXPECTED_ORIGINAL_CURRENT_AFTER}** |`,
      "",
      "| Original table | Rows |",
      "|----------------|-----:|",
      `| profiles | ${originalCounts.profiles} |`,
      `| versions | ${originalCounts.versions} |`,
      "",
      "## Classification (50 activated Wave 3 rows)",
      "",
      "| Class | Count |",
      "|-------|------:|",
      `| already_present | ${counts.already_present} |`,
      `| missing | ${counts.missing} |`,
      `| conflict | ${counts.conflict} |`,
      `| unsafe | ${counts.unsafe} |`,
      "",
      `**Insert plan rows:** ${insertPlan.length}`,
      "",
      "## Execute note",
      "",
      "Mirror staging **active** state with `effective_from=now()`; tag `PC05G_WAVE3_ORIGINAL_<execute_run_id>`.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-wave3-diff.json"),
    JSON.stringify(
      {
        run_id: runId,
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
      "# Conflict report — Wave 3 original parity",
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
      "APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY=false",
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md"),
    [
      "# Rollback plan",
      "",
      "```sql",
      `-- DELETE FROM public.product_packaging_profiles WHERE display_label = 'PC05G_WAVE3_ORIGINAL_<execute_run_id>';`,
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
        prompt: "PC05G — WAVE 3 PACKAGING ORIGINAL DATA PARITY PLAN",
        run_id: runId,
        branch,
        wave3_execute_run: WAVE3_EXECUTE_RUN,
        wave3_activate_run: WAVE3_ACTIVATE_RUN,
        batch_tag: BATCH_TAG,
        counts,
        insert_plan_rows: insertPlan.length,
        expected_original_current_after: EXPECTED_ORIGINAL_CURRENT_AFTER,
        read_only: true,
        ok,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok, outDir, counts, insert_plan_rows: insertPlan.length, blockers }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
