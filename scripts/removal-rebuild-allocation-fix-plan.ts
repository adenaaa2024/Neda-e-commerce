/**
 * REMOVAL-REBUILD-ALLOCATION-FIX-PLAN — read-only governed fix plan
 *
 *   npx tsx scripts/removal-rebuild-allocation-fix-plan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const INVESTIGATE_BASE = ".cursor/audit-reports/removal-rebuild-investigate-allocation-failures";
const OUT_BASE = ".cursor/audit-reports/removal-rebuild-allocation-fix-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-rebuild-allocation-fix-approval.md";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function latestInvestigateRun(): string {
  const base = path.join(process.cwd(), INVESTIGATE_BASE);
  if (!fs.existsSync(base)) throw new Error(`Missing ${INVESTIGATE_BASE}`);
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  if (!dirs.length) throw new Error("No investigation run found");
  return dirs[0]!;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function main(): void {
  const runId = runIdArg();
  const investigateRunId = latestInvestigateRun();
  const investigateDir = path.join(process.cwd(), INVESTIGATE_BASE, investigateRunId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const inv = readJson<{
    total_mismatches: number;
    non_overflow_bug_count: number;
    by_category: Record<string, number>;
    duplicate_remainder_detail_lines: number;
    fix_type: string;
  }>(path.join(investigateDir, "manifest.json"));

  const fixRequired = inv.total_mismatches > 0;
  const codeFunctionFixRequired = (inv.non_overflow_bug_count ?? 0) > 0;
  const staleCleanupRequired = (inv.by_category?.duplicate_key ?? 0) > 0;

  const nextPrompt = fixRequired
    ? "REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE — duplicate remainder cleanup + rebuild + verify (staging, approval-gated)"
    : "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE — verify already valid; proceed to resolver backfill";

  fs.writeFileSync(
    path.join(outDir, "fix-summary.md"),
    [
      "# Removal rebuild allocation fix — minimal governed plan",
      "",
      "## Investigation input",
      "",
      `- Run: \`${INVESTIGATE_BASE}/${investigateRunId}/\``,
      `- Total mismatches: **${inv.total_mismatches}**`,
      `- Category: **duplicate_key** (${inv.by_category?.duplicate_key ?? 0})`,
      `- Non-overflow logic bugs: **${inv.non_overflow_bug_count}**`,
      `- Duplicate remainder detail lines: **${inv.duplicate_remainder_detail_lines}**`,
      "",
      "## Fix required",
      "",
      `**${fixRequired ? "yes" : "no"}** — stale duplicate detail_remainder rows inflate live qty vs simulation.`,
      "",
      "## Minimal fix (execute pass)",
      "",
      "1. **Preimage** — export all derived EP rows before cleanup",
      "2. **Cleanup** — delete duplicate detail_remainder per source_detail_row_id (keep newest rebuild_run_at)",
      "3. **Rebuild** — rebuild_expected_packages_from_removals Sam org/store",
      "4. **Verify** — re-run removal-rebuild-verify-and-resolver-dryrun.ts; gate: rebuild_valid=yes, ep mismatch = 0",
      "",
      "## Code / function fix",
      "",
      codeFunctionFixRequired
        ? "**Required** — simulation vs rebuild logic divergence (see investigation patch-plan)."
        : "**Not required for this execute pass** — simulation and rebuild qty logic agree; issue is duplicate stale rows from repeated rebuild without dedupe.",
      "",
      "**Follow-up (separate migration, not in execute):** harden obsolete delete in rebuild_expected_packages_from_removals to collapse extra remainder rows per detail.",
      "",
      "## Approval",
      "",
      `- File: \`${APPROVAL_PATH}\``,
      "- Flags: APPROVED_TO_RUN_STAGING=true, APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX=true",
      "",
      `**Next prompt:** ${nextPrompt}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "stale-cleanup-plan.md"),
    [
      "# Stale row cleanup plan",
      "",
      "## Target",
      "",
      `- Staging: \`${STAGING_REF}\` only`,
      `- Org: \`${ORG_ID}\``,
      `- Store: \`${STORE_ID}\` (Sam AM)`,
      "",
      "## Scope",
      "",
      "Only expected_packages where build_source = detail_remainder with duplicate source_detail_row_id.",
      "",
      "## SQL (execute step)",
      "",
      "```sql",
      "BEGIN;",
      "",
      "WITH ranked AS (",
      "  SELECT id, source_detail_row_id, expected_scan_quantity, rebuild_run_at, updated_at,",
      "    row_number() OVER (",
      "      PARTITION BY organization_id, store_id, source_detail_row_id",
      "      ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC",
      "    ) AS rn",
      "  FROM public.expected_packages",
      `  WHERE organization_id = '${ORG_ID}'::uuid`,
      `    AND store_id = '${STORE_ID}'::uuid`,
      "    AND build_source = 'detail_remainder'",
      ")",
      "DELETE FROM public.expected_packages ep",
      "USING ranked r",
      "WHERE ep.id = r.id AND r.rn > 1;",
      "",
      "COMMIT;",
      "```",
      "",
      "## Expected effect",
      "",
      "- Remove ~534+ duplicate remainder rows (investigation: 55 detail lines × 2–3 copies)",
      "- detail_shipment rows untouched",
      "- Legacy rows untouched",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rebuild-rerun-plan.md"),
    [
      "# Rebuild rerun plan",
      "",
      "After cleanup:",
      "",
      "```sql",
      "SELECT * FROM public.rebuild_expected_packages_from_removals(",
      `  '${ORG_ID}'::uuid,`,
      `  '${STORE_ID}'::uuid`,
      ");",
      "```",
      "",
      "## Post-checks",
      "",
      "- detail_remainder count ≈ unique detail lines needing remainder (expect ~1,064 not ~1,598)",
      "- obsolete_rows_deleted may be > 0 on this pass",
      "- Run verify script; live_derived_qty_matches_simulation_per_detail must **pass**",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md"),
    [
      "# Rollback plan",
      "",
      "## Preimage (before execute)",
      "",
      "Execute script will write:",
      "",
      "- preimage-derived-expected-packages.json — full derived EP snapshot",
      "- preimage-duplicate-remainder-deletes.json — rows targeted for delete",
      "",
      "## Rollback",
      "",
      "1. Restore deleted rows from preimage JSON (INSERT … ON CONFLICT DO NOTHING on derived pair key)",
      "2. Or full restore: delete derived EP for org/store + re-insert from preimage",
      "",
      "Reference prior rebuild execute preimage pattern:",
      "removal-existing-csv-rebuild-execute/<run_id>/preimage-derived-expected-packages.json",
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
      "APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX=false",
      "```",
      "",
      "Execute blocked until both true.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-REBUILD-ALLOCATION-FIX-PLAN",
        run_id: runId,
        branch,
        investigate_run_id: investigateRunId,
        staging_ref: STAGING_REF,
        fix_required: fixRequired,
        code_function_fix_required: codeFunctionFixRequired,
        stale_cleanup_required: staleCleanupRequired,
        total_mismatches: inv.total_mismatches,
        fix_type: inv.fix_type,
        approval_file: APPROVAL_PATH,
        exact_next_prompt: nextPrompt,
        execute: false,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        fix_required: fixRequired,
        approval_file: APPROVAL_PATH,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main();
