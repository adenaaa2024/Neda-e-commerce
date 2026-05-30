/**
 * DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-DRYRUN (read-only)
 *   npx tsx scripts/db-parity-view-linkage-slip-columns-dryrun.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const OUT_BASE = ".cursor/audit-reports/db-parity-view-linkage-slip-columns-dryrun";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readSql(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "scripts", "db-parity-sql", name), "utf8");
}

function main(): void {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch \`${branch}\` !== \`${REQUIRED_BRANCH}\``);
  }

  const sqlDir = path.join(process.cwd(), "scripts", "db-parity-sql");
  if (!fs.existsSync(sqlDir)) {
    blockers.push("scripts/db-parity-sql/ missing — run code generation first");
  }

  for (const f of [
    "001_both_refs_inventory_views_product_linkage.sql",
    "002_both_refs_slip_contents_parsed_columns.sql",
    "003_original_expected_packages_indexes.sql",
  ]) {
    const src = path.join(sqlDir, f);
    if (!fs.existsSync(src)) blockers.push(`Missing ${f}`);
    else fs.copyFileSync(src, path.join(outDir, f));
  }

  const docs = [
    "plan-summary.md",
    "risk-analysis.md",
    "current-view-definition-snapshots.md",
    "rollback-plan.md",
    "verification-sql.md",
    "approval-files-needed.md",
    "exact-next-prompts.md",
  ];
  for (const d of docs) {
    const p = path.join(outDir, d);
    if (fs.existsSync(p)) continue;
  }

  // Written inline below via separate Write calls — script copies SQL only
  console.log(
    JSON.stringify({ ok: blockers.length === 0, outDir, blockers, runId }, null, 2),
  );
  if (blockers.length) process.exit(1);
}

main();
