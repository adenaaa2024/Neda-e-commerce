/**
 * PC05C — Packaging backfill original data parity plan (read-only).
 *
 *   npx tsx scripts/pc05c-packaging-original-data-parity-plan.ts
 *   npx tsx scripts/pc05c-packaging-original-data-parity-plan.ts --dry-run-id=20260523T220000Z
 */
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
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
const DRY_RUN_DEFAULT = "20260523T220000Z";
const DRY_RUN_BASE = ".cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run";
const CENSUS_DEFAULT = "20260526T172000Z";
const OUT_BASE = ".cursor/audit-reports/pc05c-packaging-original-data-parity-plan";
const APPROVAL_REL = ".cursor/operator-approvals/product-packaging-backfill-original-data-parity-pc05c-approval.md";

type CsvRow = Record<string, string>;

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
  current_version_id: string | null;
};

type Classification =
  | "already_in_original"
  | "missing_from_original"
  | "conflicting_in_original"
  | "unsafe_for_original";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function dryRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--dry-run-id="));
  return a ? a.split("=")[1]!.trim() : DRY_RUN_DEFAULT;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function profileKey(org: string, store: string | null, product: string, level: string, context: string): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

async function loadAcceptedCandidateRows(
  dryRunDir: string,
  acceptedPath: string,
): Promise<CsvRow[]> {
  const accepted = new Set(
    fs
      .readFileSync(acceptedPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const csvPath = path.join(dryRunDir, "candidate-rows.csv");
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
  const rows: CsvRow[] = [];
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (first) {
      headers = cols;
      first = false;
      continue;
    }
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    if (accepted.has(row.candidate_id ?? "")) rows.push(row);
  }
  return rows;
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

async function fetchPackagingByCandidates(
  client: pg.Client,
  candidateIds: string[],
): Promise<Map<string, PackagingRow>> {
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
     FROM public.product_packaging_profile_versions v
     JOIN public.product_packaging_profiles p ON p.id = v.profile_id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE v.evidence_summary->>'pc05_candidate_id' = ANY($1::text[])`,
    [candidateIds],
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
      has_current:
        row.profile_status === "active" &&
        !!row.current_version_id &&
        String(row.current_version_id) === String(row.version_id),
      current_version_id: row.current_version_id ? String(row.current_version_id) : null,
    });
  }
  return out;
}

async function fetchOriginalProfilesByKey(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
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
      display_label: row.display_label ? String(row.display_label) : null,
      has_current:
        row.profile_status === "active" &&
        !!row.current_version_id &&
        String(row.current_version_id) === String(row.version_id),
      current_version_id: row.current_version_id ? String(row.current_version_id) : null,
    });
  }
  return out;
}

async function productsExistOnOriginal(
  client: pg.Client,
  productIds: string[],
): Promise<Set<string>> {
  const r = await client.query(
    `SELECT id::text FROM public.products WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [productIds],
  );
  return new Set(r.rows.map((x: { id: string }) => x.id));
}

function approvalFileContent(): string {
  return `# Product packaging backfill — original data parity (PC05C plan)

**Default:** not approved until operator reviews plan artifacts.

| Field | Value |
|-------|--------|
| Original/current ref | \`${ORIGINAL_REF}\` |
| Staging ref (read source only) | \`${STAGING_REF}\` |
| Pilot cohort | 191 accepted PC05 staging profiles (dry-run \`${DRY_RUN_DEFAULT}\`) |
| Allowed write (when approved) | \`INSERT\` into packaging tables on original only; mirror staging pilot rows |
| Forbidden | \`UPDATE products\`, staging mutations, Amazon API, auto-execute without sign-off |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_PRODUCT_PACKAGING_BACKFILL_ORIGINAL_DATA_PARITY=false
\`\`\`

## Sign-off (fill when ready to execute)

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_PRODUCT_PACKAGING_BACKFILL_ORIGINAL_DATA_PARITY=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const dryRunId = dryRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = refFromConnectionUrl(stagingUrl) || getStagingProjectRef({ loadEnv: false });
  const originalRef = refFromConnectionUrl(originalUrl);

  const dryRunDir = path.join(process.cwd(), DRY_RUN_BASE, dryRunId);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");
  const approvalPath = path.join(process.cwd(), APPROVAL_REL);

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL missing");
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing");
  if (stagingUrl === originalUrl) blockers.push("Staging and original URLs must differ");
  if (!fs.existsSync(acceptedPath)) blockers.push(`Missing ${acceptedPath}`);

  if (!fs.existsSync(approvalPath)) {
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    fs.writeFileSync(approvalPath, approvalFileContent());
  }

  const diffRows: {
    candidate_id: string;
    composite_key: string;
    classification: Classification;
    reason: string;
    staging: PackagingRow | null;
    original: PackagingRow | null;
    product_on_original: boolean;
  }[] = [];

  let stagingRows: Map<string, PackagingRow> = new Map();
  let originalByKey: Map<string, PackagingRow> = new Map();
  let originalTableCounts = { profiles: 0, versions: 0, current: 0 };
  let productsOnOriginal = new Set<string>();

  if (blockers.length === 0) {
    const acceptedRows = await loadAcceptedCandidateRows(dryRunDir, acceptedPath);
    const candidateIds = acceptedRows.map((r) => r.candidate_id ?? "").filter(Boolean);

    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    stagingRows = await fetchPackagingByCandidates(stagingClient, candidateIds);
    originalByKey = await fetchOriginalProfilesByKey(originalClient);

    const oc = await originalClient.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
    );
    originalTableCounts = oc.rows[0] as typeof originalTableCounts;

    const productIds = [...new Set([...stagingRows.values()].map((r) => r.product_id))];
    productsOnOriginal = await productsExistOnOriginal(originalClient, productIds);

    for (const cid of candidateIds) {
      const staging = stagingRows.get(cid) ?? null;
      const csvRow = acceptedRows.find((r) => r.candidate_id === cid);
      const composite = staging
        ? profileKey(
            staging.organization_id,
            staging.store_id,
            staging.product_id,
            staging.packaging_level,
            staging.fulfillment_context,
          )
        : csvRow
          ? profileKey(
              csvRow.organization_id,
              csvRow.store_id || null,
              csvRow.product_id,
              csvRow.packaging_level,
              csvRow.fulfillment_context,
            )
          : cid;

      let classification: Classification = "missing_from_original";
      let reason = "";
      const productOnOriginal = staging ? productsOnOriginal.has(staging.product_id) : false;

      if (!staging) {
        classification = "unsafe_for_original";
        reason = "staging_packaging_row_not_found_for_candidate";
      } else if (!productOnOriginal) {
        classification = "unsafe_for_original";
        reason = "product_id_not_on_original";
      } else {
        const orig = originalByKey.get(composite) ?? null;
        if (!orig) {
          classification = "missing_from_original";
          reason = "no_matching_profile_on_original";
        } else if (!dimsMatch(staging, orig) || staging.profile_status !== orig.profile_status) {
          classification = "conflicting_in_original";
          reason = !dimsMatch(staging, orig)
            ? "dimension_or_unit_mismatch"
            : `status_mismatch_staging_${staging.profile_status}_original_${orig.profile_status}`;
        } else if (staging.has_current && orig.has_current) {
          classification = "already_in_original";
          reason = "composite_key_active_with_matching_current";
        } else if (!orig.has_current && staging.has_current) {
          classification = "missing_from_original";
          reason = "original_profile_exists_but_no_current_snapshot";
        } else {
          classification = "already_in_original";
          reason = "composite_key_match";
        }
      }

      diffRows.push({
        candidate_id: cid,
        composite_key: composite,
        classification,
        reason,
        staging,
        original: staging ? (originalByKey.get(composite) ?? null) : null,
        product_on_original: productOnOriginal,
      });
    }

    await stagingClient.end();
    await originalClient.end();
  }

  const counts = {
    staging_rows: stagingRows.size,
    already_in_original: diffRows.filter((d) => d.classification === "already_in_original").length,
    missing_from_original: diffRows.filter((d) => d.classification === "missing_from_original").length,
    conflicting_in_original: diffRows.filter((d) => d.classification === "conflicting_in_original").length,
    unsafe_for_original: diffRows.filter((d) => d.classification === "unsafe_for_original").length,
  };

  const insertPlan = diffRows
    .filter((d) => d.classification === "missing_from_original" && d.staging)
    .map((d) => {
      const s = d.staging!;
      return {
        candidate_id: d.candidate_id,
        composite_key: d.composite_key,
        organization_id: s.organization_id,
        store_id: s.store_id,
        product_id: s.product_id,
        packaging_level: s.packaging_level,
        fulfillment_context: s.fulfillment_context,
        profile_status: s.profile_status,
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
          pc05_original_parity_plan_run_id: runId,
          pc05_candidate_id: d.candidate_id,
          mirrored_from: STAGING_REF,
        },
        display_label: `PC05C_ORIGINAL_PARITY_${runId}`,
        proposed_action: "INSERT profile + version; activate only if separate activate approval",
      };
    });

  const conflicts = diffRows.filter((d) => d.classification === "conflicting_in_original");
  const unsafe = diffRows.filter((d) => d.classification === "unsafe_for_original");

  fs.writeFileSync(
    path.join(outDir, "original-data-parity-plan.md"),
    [
      "# Original data parity plan — PC05C (plan only)",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging ref:** \`${STAGING_REF}\` (read-only source)`,
      `**Original ref:** \`${ORIGINAL_REF}\` (no writes this run)`,
      `**Pilot cohort:** 191 accepted PC05 candidates (\`${dryRunId}\`)`,
      "",
      "## Schema parity (prerequisite)",
      "",
      "- PC04A staging packaging DDL: PASS",
      "- PC04B original packaging DDL: IN PARITY",
      "",
      "## Current original packaging table counts",
      "",
      "| Table | Rows on original |",
      "|-------|-----------------:|",
      `| product_packaging_profiles | ${originalTableCounts.profiles} |`,
      `| product_packaging_profile_versions | ${originalTableCounts.versions} |`,
      `| product_packaging_dimensions_current | ${originalTableCounts.current} |`,
      "",
      "## Pilot cohort classification (191)",
      "",
      "| Classification | Count |",
      "|----------------|------:|",
      `| already_in_original | ${counts.already_in_original} |`,
      `| missing_from_original | ${counts.missing_from_original} |`,
      `| conflicting_in_original | ${counts.conflicting_in_original} |`,
      `| unsafe_for_original | ${counts.unsafe_for_original} |`,
      "",
      "## Recommended execute order (after approval)",
      "",
      `1. Operator signs \`${APPROVAL_REL}\` with both flags \`true\`.`,
      "2. Run governed **PC05C-ORIGINAL-EXECUTE** script (to be added): INSERT profiles + versions for \`missing_from_original\` only.",
      "3. Skip \`already_in_original\` (idempotent).",
      "4. Hold \`conflicting_in_original\` and \`unsafe_for_original\` for manual triage — do not auto-overwrite.",
      "5. Separate activate step if versions inserted as \`needs_review\`; pilot staging rows are already \`active\` with current snapshots.",
      "",
      "## Insert scope",
      "",
      `- Planned inserts: **${insertPlan.length}** profile+version pairs`,
      `- No \`products\` table updates`,
      `- Evidence carries \`pc05_candidate_id\` + plan run id for rollback tagging`,
      "",
      "## Rollback",
      "",
      "See \`rollback-plan.md\` — delete by \`display_label = PC05C_ORIGINAL_PARITY_<run_id>\`.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-packaging-diff.json"),
    JSON.stringify(
      {
        run_id: runId,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        original_table_counts: originalTableCounts,
        counts,
        rows: diffRows.map((d) => ({
          candidate_id: d.candidate_id,
          composite_key: d.composite_key,
          classification: d.classification,
          reason: d.reason,
          product_on_original: d.product_on_original,
          staging_profile_id: d.staging?.profile_id ?? null,
          original_profile_id: d.original?.profile_id ?? null,
          staging_status: d.staging?.profile_status ?? null,
          original_status: d.original?.profile_status ?? null,
          staging_has_current: d.staging?.has_current ?? false,
          original_has_current: d.original?.has_current ?? false,
        })),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(outDir, "original-insert-plan.json"), JSON.stringify(insertPlan, null, 2));

  fs.writeFileSync(
    path.join(outDir, "conflict-report.md",
    ),
    [
      "# Conflict report",
      "",
      `Conflicts: **${conflicts.length}**`,
      `Unsafe: **${unsafe.length}**`,
      "",
      conflicts.length
        ? [
            "## conflicting_in_original",
            "",
            "| candidate_id | reason | staging_profile | original_profile |",
            "|--------------|--------|-----------------|------------------|",
            ...conflicts.map(
              (c) =>
                `| ${c.candidate_id} | ${c.reason} | ${c.staging?.profile_id ?? "—"} | ${c.original?.profile_id ?? "—"} |`,
            ),
          ].join("\n")
        : "No dimension/status conflicts for pilot cohort.",
      "",
      unsafe.length
        ? [
            "## unsafe_for_original",
            "",
            "| candidate_id | reason | product_on_original |",
            "|--------------|--------|---------------------|",
            ...unsafe.map(
              (c) => `| ${c.candidate_id} | ${c.reason} | ${c.product_on_original} |`,
            ),
          ].join("\n")
        : "No unsafe rows.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md",
    ),
    [
      "# Approval file (plan copy)",
      "",
      `Path: \`${APPROVAL_REL}\``,
      "",
      "Default flags (do not execute until operator sets both to `true`):",
      "",
      "```text",
      "APPROVED_TO_RUN_ORIGINAL=false",
      "APPROVED_PRODUCT_PACKAGING_BACKFILL_ORIGINAL_DATA_PARITY=false",
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md",
    ),
    [
      "# Rollback plan — original data parity execute",
      "",
      `Target: \`${ORIGINAL_REF}\` only`,
      "",
      "```sql",
      "-- Emergency rollback after PC05C original execute",
      "BEGIN;",
      `-- DELETE FROM public.product_packaging_profiles WHERE display_label = 'PC05C_ORIGINAL_PARITY_${runId}';`,
      "-- CASCADE removes versions + dimensions_current via FK/trigger",
      "COMMIT;",
      "NOTIFY pgrst, 'reload schema';",
      "```",
      "",
      "Pre-execute: export `original-insert-plan.json` row count and profile ids for audit.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md",
    ),
    [
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["None."]),
      counts.unsafe_for_original > 0
        ? `- **${counts.unsafe_for_original}** unsafe rows block blind bulk execute`
        : "",
      counts.conflicting_in_original > 0
        ? `- **${counts.conflicting_in_original}** conflicts require operator triage before overwrite`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const ok = blockers.length === 0 && counts.staging_rows === 191;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05C — PACKAGING BACKFILL ORIGINAL DATA PARITY PLAN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        dry_run_id: dryRunId,
        read_only: true,
        counts,
        insert_plan_rows: insertPlan.length,
        approval_file: APPROVAL_REL,
        ok,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify({ ok, outDir, counts, insert_plan_rows: insertPlan.length, blockers }, null, 2),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
