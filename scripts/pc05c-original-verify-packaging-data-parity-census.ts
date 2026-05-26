/**
 * PC05C-ORIGINAL-VERIFY — Packaging data parity census (read-only).
 *
 *   npx tsx scripts/pc05c-original-verify-packaging-data-parity-census.ts
 *   npx tsx scripts/pc05c-original-verify-packaging-data-parity-census.ts --dry-run-id=20260523T220000Z
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

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const DRY_RUN_DEFAULT = "20260523T220000Z";
const DRY_RUN_BASE = ".cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run";
const PC05C_EXECUTE_RUN = "20260526T180000Z";
const OUT_BASE = ".cursor/audit-reports/pc05c-original-verify-packaging-data-parity-census";

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
  has_current: boolean;
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

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
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

async function loadAcceptedCandidateRows(dryRunDir: string, acceptedPath: string): Promise<CsvRow[]> {
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

async function fetchPackagingByCandidates(
  client: pg.Client,
  candidateIds: string[],
): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score,
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
      has_current:
        row.profile_status === "active" &&
        !!row.current_version_id &&
        String(row.current_version_id) === String(row.version_id),
    });
  }
  return out;
}

async function fetchOriginalProfilesByKey(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score,
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
      candidate_id: row.candidate_id ? String(row.candidate_id) : "",
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
      has_current:
        row.profile_status === "active" &&
        !!row.current_version_id &&
        String(row.current_version_id) === String(row.version_id),
    });
  }
  return out;
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
  const executeManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05c-packaging-original-data-parity-execute",
    PC05C_EXECUTE_RUN,
    "manifest.json",
  );

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl || !originalUrl) blockers.push("STAGING and ORIGINAL postgres URLs required");
  if (stagingUrl === originalUrl) blockers.push("Staging and original URLs must differ");
  if (!fs.existsSync(acceptedPath)) blockers.push(`Missing ${acceptedPath}`);
  if (!fs.existsSync(executeManifestPath)) {
    blockers.push(`Missing PC05C execute proof: ${PC05C_EXECUTE_RUN}`);
  } else {
    try {
      const em = JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as {
        ok?: boolean;
        inserted_profiles?: number;
      };
      if (!em.ok || (em.inserted_profiles ?? 0) < 191) {
        blockers.push(`PC05C execute not ok or <191 inserts: ${PC05C_EXECUTE_RUN}`);
      }
    } catch {
      blockers.push("Invalid PC05C execute manifest");
    }
  }

  const diffRows: {
    candidate_id: string;
    composite_key: string;
    classification: Classification;
    reason: string;
    staging_profile_id: string | null;
    original_profile_id: string | null;
    staging_has_current: boolean;
    original_has_current: boolean;
  }[] = [];

  let stagingRowCount = 0;
  let originalTableCounts = { profiles: 0, versions: 0, current: 0 };

  if (blockers.length === 0) {
    const acceptedRows = await loadAcceptedCandidateRows(dryRunDir, acceptedPath);
    const candidateIds = acceptedRows.map((r) => r.candidate_id ?? "").filter(Boolean);
    if (candidateIds.length !== 191) blockers.push(`Expected 191 accepted ids, got ${candidateIds.length}`);

    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    const stagingRows = await fetchPackagingByCandidates(stagingClient, candidateIds);
    const originalByKey = await fetchOriginalProfilesByKey(originalClient);
    stagingRowCount = stagingRows.size;

    const oc = await originalClient.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
    );
    originalTableCounts = oc.rows[0] as typeof originalTableCounts;

    for (const cid of candidateIds) {
      const staging = stagingRows.get(cid) ?? null;
      const composite = staging
        ? profileKey(
            staging.organization_id,
            staging.store_id,
            staging.product_id,
            staging.packaging_level,
            staging.fulfillment_context,
          )
        : cid;

      let classification: Classification = "missing_from_original";
      let reason = "";

      if (!staging) {
        classification = "unsafe_for_original";
        reason = "staging_row_missing";
      } else {
        const orig = originalByKey.get(composite) ?? null;
        if (!orig) {
          classification = "missing_from_original";
          reason = "no_matching_profile_on_original";
        } else if (!dimsMatch(staging, orig) || staging.profile_status !== orig.profile_status) {
          classification = "conflicting_in_original";
          reason = !dimsMatch(staging, orig) ? "dimension_or_unit_mismatch" : "status_mismatch";
        } else if (!staging.has_current || !orig.has_current) {
          classification = "missing_from_original";
          reason = "missing_current_snapshot";
        } else {
          classification = "already_in_original";
          reason = "parity_match";
        }
      }

      diffRows.push({
        candidate_id: cid,
        composite_key: composite,
        classification,
        reason,
        staging_profile_id: staging?.profile_id ?? null,
        original_profile_id: staging ? (originalByKey.get(composite)?.profile_id ?? null) : null,
        staging_has_current: staging?.has_current ?? false,
        original_has_current: staging ? (originalByKey.get(composite)?.has_current ?? false) : false,
      });
    }

    await stagingClient.end();
    await originalClient.end();
  }

  const counts = {
    staging_rows: stagingRowCount,
    already_in_original: diffRows.filter((d) => d.classification === "already_in_original").length,
    missing_from_original: diffRows.filter((d) => d.classification === "missing_from_original").length,
    conflicting_in_original: diffRows.filter((d) => d.classification === "conflicting_in_original").length,
    unsafe_for_original: diffRows.filter((d) => d.classification === "unsafe_for_original").length,
  };

  const expectedPass =
    counts.staging_rows === 191 &&
    counts.already_in_original === 191 &&
    counts.missing_from_original === 0 &&
    counts.conflicting_in_original === 0 &&
    counts.unsafe_for_original === 0;

  const conflicts = diffRows.filter((d) => d.classification === "conflicting_in_original");
  const missing = diffRows.filter((d) => d.classification === "missing_from_original");
  const unsafe = diffRows.filter((d) => d.classification === "unsafe_for_original");

  fs.writeFileSync(
    path.join(outDir, "parity-census.md"),
    [
      "# Parity census — PC05C-ORIGINAL-VERIFY",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging:** \`${STAGING_REF}\` | **Original:** \`${ORIGINAL_REF}\``,
      `**Dry-run cohort:** \`${dryRunId}\` (191 pilot)`,
      `**PC05C execute proof:** \`${PC05C_EXECUTE_RUN}\``,
      "",
      "## Verification matrix",
      "",
      "| Check | Expected | Actual | Pass |",
      "|-------|----------|--------|------|",
      `| staging_rows | 191 | ${counts.staging_rows} | ${counts.staging_rows === 191 ? "YES" : "NO"} |`,
      `| already_in_original | 191 | ${counts.already_in_original} | ${counts.already_in_original === 191 ? "YES" : "NO"} |`,
      `| missing_from_original | 0 | ${counts.missing_from_original} | ${counts.missing_from_original === 0 ? "YES" : "NO"} |`,
      `| conflicting_in_original | 0 | ${counts.conflicting_in_original} | ${counts.conflicting_in_original === 0 ? "YES" : "NO"} |`,
      `| unsafe_for_original | 0 | ${counts.unsafe_for_original} | ${counts.unsafe_for_original === 0 ? "YES" : "NO"} |`,
      "",
      `**Overall parity:** ${expectedPass ? "**PASS**" : "**FAIL**"}`,
      "",
      "## Original table totals",
      "",
      `| Table | Rows |`,
      `|-------|-----:|`,
      `| product_packaging_profiles | ${originalTableCounts.profiles} |`,
      `| product_packaging_profile_versions | ${originalTableCounts.versions} |`,
      `| product_packaging_dimensions_current | ${originalTableCounts.current} |`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-packaging-diff.json"),
    JSON.stringify(
      {
        run_id: runId,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        pc05c_execute_run: PC05C_EXECUTE_RUN,
        original_table_counts: originalTableCounts,
        counts,
        parity_pass: expectedPass,
        rows: diffRows,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "conflict-report.md"),
    [
      "# Conflict report",
      "",
      `Conflicts: **${conflicts.length}**`,
      `Missing: **${missing.length}**`,
      `Unsafe: **${unsafe.length}**`,
      "",
      conflicts.length
        ? conflicts
            .slice(0, 30)
            .map((c) => `- \`${c.candidate_id}\`: ${c.reason}`)
            .join("\n")
        : "No conflicts.",
      "",
      missing.length
        ? missing
            .slice(0, 30)
            .map((c) => `- \`${c.candidate_id}\`: ${c.reason}`)
            .join("\n")
        : "No missing rows.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- Mode: **read-only verify**",
      "- No INSERT/UPDATE/DELETE on staging or original",
      "- No `products` changes",
      "- No Amazon API / no OpenAI",
      `- Script: \`scripts/pc05c-original-verify-packaging-data-parity-census.ts\``,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["None."]),
      !expectedPass && blockers.length === 0 ? "- Parity matrix did not meet 191/191 PASS criteria" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const ok = blockers.length === 0 && expectedPass;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05C-ORIGINAL-VERIFY — PACKAGING DATA PARITY CENSUS",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        dry_run_id: dryRunId,
        pc05c_execute_run: PC05C_EXECUTE_RUN,
        read_only: true,
        counts,
        parity_pass: expectedPass,
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
        outDir,
        counts,
        parity_pass: expectedPass,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
