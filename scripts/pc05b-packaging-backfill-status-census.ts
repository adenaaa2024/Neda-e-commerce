/**
 * PC05B — Packaging backfill status census (read-only, staging).
 *
 *   npx tsx scripts/pc05b-packaging-backfill-status-census.ts
 *   npx tsx scripts/pc05b-packaging-backfill-status-census.ts --dry-run-id=20260523T220000Z
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
const OUT_BASE = ".cursor/audit-reports/pc05b-packaging-backfill-status-census";

type CsvRow = Record<string, string>;

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

function profileKey(org: string, store: string | null, product: string, level: string, context: string): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const dryRunId = dryRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const dryRunDir = path.join(process.cwd(), DRY_RUN_BASE, dryRunId);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
  if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use ORIGINAL URL");
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL missing");
  if (!fs.existsSync(acceptedPath)) blockers.push(`Missing ${acceptedPath}`);

  let acceptedRows: CsvRow[] = [];
  if (blockers.length === 0) {
    try {
      acceptedRows = await loadAcceptedCandidateRows(dryRunDir, acceptedPath);
    } catch (e) {
      blockers.push(e instanceof Error ? e.message : String(e));
    }
  }

  const census = {
    profiles_total: 0,
    versions_total: 0,
    dimensions_current_total: 0,
    version_status_counts: {} as Record<string, number>,
    profile_display_label_counts: {} as Record<string, number>,
    evidence_rows_with_candidate_id: 0,
  };

  const candidateStatuses: {
    candidate_id: string;
    profile_found: boolean;
    profile_id: string | null;
    version_id: string | null;
    version_status: string | null;
    has_current_snapshot: boolean;
    current_version_id: string | null;
    match_method: string;
  }[] = [];

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const profCount = await client.query(`SELECT count(*)::int c FROM public.product_packaging_profiles`);
    const verCount = await client.query(`SELECT count(*)::int c FROM public.product_packaging_profile_versions`);
    const curCount = await client.query(`SELECT count(*)::int c FROM public.product_packaging_dimensions_current`);
    census.profiles_total = profCount.rows[0]?.c ?? 0;
    census.versions_total = verCount.rows[0]?.c ?? 0;
    census.dimensions_current_total = curCount.rows[0]?.c ?? 0;

    const verByStatus = await client.query(
      `SELECT profile_status, count(*)::int c
       FROM public.product_packaging_profile_versions
       GROUP BY profile_status ORDER BY profile_status`,
    );
    for (const r of verByStatus.rows as { profile_status: string; c: number }[]) {
      census.version_status_counts[r.profile_status] = r.c;
    }

    const labelCounts = await client.query(
      `SELECT coalesce(display_label, '(null)') AS label, count(*)::int c
       FROM public.product_packaging_profiles
       GROUP BY display_label ORDER BY c DESC LIMIT 20`,
    );
    for (const r of labelCounts.rows as { label: string; c: number }[]) {
      census.profile_display_label_counts[r.label] = r.c;
    }

    const evidenceCand = await client.query(
      `SELECT count(*)::int c FROM public.product_packaging_profile_versions
       WHERE evidence_summary ? 'pc05_candidate_id'`,
    );
    census.evidence_rows_with_candidate_id = evidenceCand.rows[0]?.c ?? 0;

    const allProfiles = await client.query(
      `SELECT id::text, organization_id::text, store_id::text, product_id::text,
              packaging_level, fulfillment_context
       FROM public.product_packaging_profiles`,
    );
    const profileByKey = new Map<string, string>();
    for (const r of allProfiles.rows as Record<string, string | null>[]) {
      profileByKey.set(
        profileKey(
          String(r.organization_id),
          r.store_id ? String(r.store_id) : null,
          String(r.product_id),
          String(r.packaging_level),
          String(r.fulfillment_context),
        ),
        String(r.id),
      );
    }

    const versions = await client.query(
      `SELECT v.id::text AS version_id, v.profile_id::text, v.profile_status,
              v.evidence_summary->>'pc05_candidate_id' AS pc05_candidate_id,
              c.current_version_id::text AS current_version_id
       FROM public.product_packaging_profile_versions v
       LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = v.profile_id`,
    );
    const versionByCandidate = new Map<string, (typeof versions.rows)[0]>();
    const versionsByProfile = new Map<string, (typeof versions.rows)[0][]>();
    for (const v of versions.rows as {
      version_id: string;
      profile_id: string;
      profile_status: string;
      pc05_candidate_id: string | null;
      current_version_id: string | null;
    }[]) {
      if (v.pc05_candidate_id) versionByCandidate.set(v.pc05_candidate_id, v);
      const list = versionsByProfile.get(v.profile_id) ?? [];
      list.push(v);
      versionsByProfile.set(v.profile_id, list);
    }

    for (const row of acceptedRows) {
      const cid = row.candidate_id ?? "";
      let profileId: string | null = null;
      let versionRow: (typeof versions.rows)[0] | undefined;
      let matchMethod = "none";

      const byEvidence = versionByCandidate.get(cid);
      if (byEvidence) {
        versionRow = byEvidence;
        profileId = String(byEvidence.profile_id);
        matchMethod = "evidence_pc05_candidate_id";
      } else {
        const key = profileKey(
          row.organization_id,
          row.store_id || null,
          row.product_id,
          row.packaging_level,
          row.fulfillment_context,
        );
        profileId = profileByKey.get(key) ?? null;
        if (profileId) {
          const profVersions = versionsByProfile.get(profileId) ?? [];
          versionRow = profVersions.find((v) => v.pc05_candidate_id === cid) ?? profVersions[0];
          matchMethod = versionRow ? "profile_composite_key" : "profile_only_no_version";
        }
      }

      const versionId = versionRow ? String(versionRow.version_id) : null;
      const versionStatus = versionRow ? String(versionRow.profile_status) : null;
      const currentVid = versionRow?.current_version_id ? String(versionRow.current_version_id) : null;
      const hasCurrent =
        !!versionRow &&
        versionStatus === "active" &&
        !!currentVid &&
        currentVid === String(versionRow.version_id);

      candidateStatuses.push({
        candidate_id: cid,
        profile_found: !!profileId,
        profile_id: profileId,
        version_id: versionId,
        version_status: versionStatus,
        has_current_snapshot: hasCurrent,
        current_version_id: currentVid,
        match_method: matchMethod,
      });
    }

    await client.end();
  }

  const acceptedCount = acceptedRows.length;
  const summary = {
    profile_found: candidateStatuses.filter((c) => c.profile_found).length,
    profile_missing: candidateStatuses.filter((c) => !c.profile_found).length,
    active_with_current: candidateStatuses.filter((c) => c.has_current_snapshot).length,
    needs_review: candidateStatuses.filter((c) => c.version_status === "needs_review").length,
    draft: candidateStatuses.filter((c) => c.version_status === "draft").length,
    active_not_current: candidateStatuses.filter(
      (c) => c.version_status === "active" && !c.has_current_snapshot,
    ).length,
    rejected: candidateStatuses.filter((c) => c.version_status === "rejected").length,
    superseded: candidateStatuses.filter((c) => c.version_status === "superseded").length,
    other_status: candidateStatuses.filter(
      (c) =>
        c.version_status &&
        !["active", "needs_review", "draft", "rejected", "superseded"].includes(c.version_status),
    ).length,
  };

  const activationNeeded =
    summary.needs_review > 0 ||
    summary.draft > 0 ||
    summary.profile_missing > 0 ||
    summary.active_not_current > 0;

  const activationReasons: string[] = [];
  if (summary.needs_review > 0) activationReasons.push(`${summary.needs_review} accepted candidates still needs_review`);
  if (summary.draft > 0) activationReasons.push(`${summary.draft} accepted candidates still draft`);
  if (summary.profile_missing > 0) activationReasons.push(`${summary.profile_missing} accepted candidates missing profile`);
  if (summary.active_not_current > 0)
    activationReasons.push(`${summary.active_not_current} active versions without matching current snapshot`);
  if (!activationNeeded) activationReasons.push("All accepted candidates have active versions with current snapshots");

  const staleOrMissing = candidateStatuses.filter(
    (c) => !c.profile_found || !c.has_current_snapshot,
  );

  fs.writeFileSync(
    path.join(outDir, "packaging-status-census.md"),
    [
      "# Packaging status census — PC05B (read-only)",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging ref:** \`${STAGING_REF}\``,
      `**Dry-run source:** \`${dryRunId}\``,
      "",
      "## Table totals (staging)",
      "",
      "| Table / metric | Count |",
      "|----------------|------:|",
      `| product_packaging_profiles | ${census.profiles_total} |`,
      `| product_packaging_profile_versions | ${census.versions_total} |`,
      `| product_packaging_dimensions_current | ${census.dimensions_current_total} |`,
      `| versions with pc05_candidate_id in evidence | ${census.evidence_rows_with_candidate_id} |`,
      "",
      "## Version status (all staging versions)",
      "",
      "| profile_status | Count |",
      "|----------------|------:|",
      ...Object.entries(census.version_status_counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, c]) => `| ${s} | ${c} |`),
      "",
      "## Profile display_label (top batches)",
      "",
      "| display_label | Count |",
      "|---------------|------:|",
      ...Object.entries(census.profile_display_label_counts).map(([l, c]) => `| ${l} | ${c} |`),
      "",
      "## Accepted PC05 cohort (191 pilot)",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| Accepted candidate ids | ${acceptedCount} |`,
      `| Profile found | ${summary.profile_found} |`,
      `| Profile missing | ${summary.profile_missing} |`,
      `| Active + current snapshot | ${summary.active_with_current} |`,
      `| needs_review | ${summary.needs_review} |`,
      `| draft | ${summary.draft} |`,
      `| active without current | ${summary.active_not_current} |`,
      `| rejected | ${summary.rejected} |`,
      `| superseded | ${summary.superseded} |`,
      "",
      "**Note:** `product_packaging_profiles` has no `profile_status` column; version `profile_status` is the lifecycle field.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "accepted-candidate-status.json"),
    JSON.stringify({ accepted_count: acceptedCount, summary, candidates: candidateStatuses }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "activation-needed.md"),
    [
      "# Activation needed?",
      "",
      `**Answer: ${activationNeeded ? "YES" : "NO"}**`,
      "",
      "## Rationale",
      "",
      ...activationReasons.map((r) => `- ${r}`),
      "",
      "## PC05B activate script",
      "",
      activationNeeded
        ? "Run governed `pc05b-product-packaging-backfill-review-activate-staging.ts` only for versions still `needs_review` / `draft` after operator review."
        : "Skip PC05B activation — cohort already active with `product_packaging_dimensions_current` populated.",
      "",
      "## Cross-check",
      "",
      `- Staging dimensions_current rows: **${census.dimensions_current_total}**`,
      `- Accepted with active+current: **${summary.active_with_current}** / **${acceptedCount}**`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "stale-or-missing-current.md",
    ),
    [
      "# Stale or missing current snapshot",
      "",
      `Rows needing attention: **${staleOrMissing.length}**`,
      "",
      staleOrMissing.length === 0
        ? "None — every accepted candidate has a profile and active current snapshot."
        : [
            "| candidate_id | profile_found | version_status | has_current | match_method |",
            "|--------------|---------------|----------------|-------------|--------------|",
            ...staleOrMissing.slice(0, 50).map(
              (c) =>
                `| ${c.candidate_id} | ${c.profile_found} | ${c.version_status ?? "—"} | ${c.has_current_snapshot} | ${c.match_method} |`,
            ),
            staleOrMissing.length > 50 ? `\n_…and ${staleOrMissing.length - 50} more (see accepted-candidate-status.json)_` : "",
          ].join("\n"),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- Mode: **read-only census**",
      "- No `INSERT`, `UPDATE`, or `DELETE` executed",
      "- No `profile_status` changes",
      "- Target: staging `eiqfaapyumhixxoeltgu` only",
      `- Original \`${ORIGINAL_REF}\` not connected for writes`,
      "- No Amazon API / no OpenAI",
      `- Script: \`scripts/pc05b-packaging-backfill-status-census.ts\``,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.",
  );

  const ok = blockers.length === 0;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05B — PACKAGING BACKFILL STATUS CENSUS",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        dry_run_id: dryRunId,
        read_only: true,
        accepted_count: acceptedCount,
        activation_needed: activationNeeded,
        summary,
        census,
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
        accepted: acceptedCount,
        active_with_current: summary.active_with_current,
        needs_review: summary.needs_review,
        activation_needed: activationNeeded,
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
