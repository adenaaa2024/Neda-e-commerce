/**
 * CI guard: scripts that insert return_items must call assertScriptReturnItemsWriteAllowed
 * or be explicitly allowlisted (legacy staging smokes).
 *
 *   npx tsx scripts/test-return-items-script-insert-guard.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");
const GUARD_FN = "assertScriptReturnItemsWriteAllowed";
const GUARD_FN_2 = "assertReturnItemsInsertNotSyntheticBulkOrphan";

/** Legacy staging smokes — must not add new entries without review. */
const ALLOWLIST = new Set([
  "test-return-items-script-insert-guard.ts",
  "return-items-bulk-orphan-lockdown-staging-execute.ts",
  "test-return-items-synthetic-insert-guard.ts",
  "test-expected-receive-delete-release.ts",
  "test-delete-undo-v2-app-wiring-staging.ts",
  "phase1-delete-move-parity-staging-smoke.ts",
  "test-box-slip-alloc-failure-parity.ts",
  "neda-item-level-receive-smoke-after-repair.ts",
  "scanner-neda-06-small-write-smoke.ts",
  "scanner-neda-11-authenticated-staging-e2e.ts",
  "scanner-neda-14-final-operator-workflow-signoff.ts",
  "next-scanner-04-staging-e2e.ts",
  "scanner-issue-to-claim-auto-flow-implement-smoke.ts",
  "neda-scanner-expected-link-write-verify.ts",
  "scanner-claim-promote-guard-smoke.ts",
  "phase1-end-to-end-staging-smoke-scanner-product-claim.ts",
]);

const INSERT_PATTERNS = [
  /\.from\s*\(\s*RETURN_ITEMS_TABLE\s*\)[\s\S]{0,120}\.insert\s*\(/,
  /\.from\s*\(\s*["']return_items["']\s*\)[\s\S]{0,120}\.insert\s*\(/,
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) continue;
    if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function main(): void {
  const violations: Array<{ file: string; reason: string }> = [];

  for (const filePath of listTsFiles(SCRIPTS_DIR)) {
    const base = path.basename(filePath);
    if (ALLOWLIST.has(base)) continue;

    const text = fs.readFileSync(filePath, "utf8");
    const hasInsert = INSERT_PATTERNS.some((re) => re.test(text));
    if (!hasInsert) continue;

    const hasGuard =
      text.includes(GUARD_FN) ||
      text.includes(GUARD_FN_2) ||
      text.includes("insertReturn(");

    if (!hasGuard) {
      violations.push({
        file: path.relative(process.cwd(), filePath),
        reason: `return_items .insert without ${GUARD_FN} or allowlist`,
      });
    }
  }

  if (violations.length > 0) {
    console.error(JSON.stringify({ ok: false, violations }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        allowlist_size: ALLOWLIST.size,
        message: "No unallowlisted script inserts return_items without write guard",
      },
      null,
      2,
    ),
  );
  assert.equal(violations.length, 0);
}

main();
