/**
 * PC05-WAVE3-EXECUTE — Wave 3 staging packaging insert (50 PIM pack-structure, needs_review).
 *
 *   npx tsx scripts/pc05-wave3-packaging-staging-execute.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const DRY_RUN_ID = "20260523T220000Z";
const MANUAL_REVIEW_PLAN_RUN = "20260526T220000Z";
const DRY_RUN_DIR = `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_ID}`;
const WAVE3_PLAN_FILE = `.cursor/audit-reports/pc05-manual-review-queue-plan/${MANUAL_REVIEW_PLAN_RUN}/backlog-classification.json`;
const APPROVAL_PATH = ".cursor/operator-approvals/product-packaging-wave3-staging-execute-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc05-wave3-packaging-staging-execute";
const PARITY_VERIFY_BASE = ".cursor/audit-reports/pc05-packaging-full-parity-verify";
const EXPECTED_WAVE3 = 50;
const EXPECTED_PARITY_TOTAL = 441;
const PILOT_BACKUP = "accepted-candidate-ids.pilot191.txt";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readWave3Approval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const execM = text.match(/APPROVED_PRODUCT_PACKAGING_WAVE3_EXECUTE\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const execVal = execM?.[1] ?? "";
  return {
    valid: runVal === "true" && execVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_PRODUCT_PACKAGING_WAVE3_EXECUTE: execVal,
    },
  };
}

function findParityVerifyRun(): string | null {
  const base = path.join(process.cwd(), PARITY_VERIFY_BASE);
  if (!fs.existsSync(base)) return null;
  const runs = fs
    .readdirSync(base)
    .filter((d) => fs.existsSync(path.join(base, d, "manifest.json")))
    .sort()
    .reverse();
  for (const run of runs) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, run, "manifest.json"), "utf8")) as {
        ok?: boolean;
        parity_pass?: boolean;
        staging_dimensions_current?: number;
        counts?: { staging_total?: number };
      };
      const stagingTotal = m.counts?.staging_total ?? m.staging_dimensions_current ?? 0;
      if (m.ok && m.parity_pass && stagingTotal === EXPECTED_PARITY_TOTAL) return run;
    } catch {
      /* skip */
    }
  }
  return null;
}

function preconditionOk(): string[] {
  const blockers: string[] = [];
  const approval = readWave3Approval();
  if (!approval.valid) blockers.push("Wave3 execute approval flags not both true");

  if (!fs.existsSync(path.join(process.cwd(), WAVE3_PLAN_FILE))) {
    blockers.push(`Missing manual-review plan: ${MANUAL_REVIEW_PLAN_RUN}`);
  }

  const parityRun = findParityVerifyRun();
  if (!parityRun) {
    blockers.push(
      `Missing PASS full parity verify (${EXPECTED_PARITY_TOTAL}/${EXPECTED_PARITY_TOTAL}); run pc05-packaging-full-parity-verify.ts`,
    );
  }

  return blockers;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readWave3Approval();
  const preBlockers = preconditionOk();

  if (preBlockers.length) {
    fs.writeFileSync(
      path.join(outDir, "approval-proof.md"),
      [
        "# Approval proof — PC05 Wave 3",
        "",
        `File: \`${APPROVAL_PATH}\``,
        "",
        "```text",
        `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
        `APPROVED_PRODUCT_PACKAGING_WAVE3_EXECUTE=${approval.raw.APPROVED_PRODUCT_PACKAGING_WAVE3_EXECUTE}`,
        "```",
        "",
        `Valid: **${approval.valid ? "YES" : "NO"}**`,
      ].join("\n"),
    );
    fs.writeFileSync(path.join(outDir, "blockers.md"), preBlockers.map((b) => `- ${b}`).join("\n"));
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ ok: false, run_id: runId, approval_valid: approval.valid, blockers: preBlockers }, null, 2),
    );
    console.log(JSON.stringify({ ok: false, outDir, approval_valid: approval.valid, blockers: preBlockers }, null, 2));
    process.exit(1);
  }

  const plan = JSON.parse(fs.readFileSync(path.join(process.cwd(), WAVE3_PLAN_FILE), "utf8")) as {
    wave3_proposed_ids: string[];
  };
  const wave3 = plan.wave3_proposed_ids ?? [];
  if (wave3.length !== EXPECTED_WAVE3) {
    console.error(JSON.stringify({ ok: false, error: `Expected ${EXPECTED_WAVE3} wave3 ids, got ${wave3.length}` }));
    process.exit(1);
  }

  const dryRunDir = path.join(process.cwd(), DRY_RUN_DIR);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");
  const pilotBackupPath = path.join(dryRunDir, PILOT_BACKUP);

  if (fs.existsSync(acceptedPath) && !fs.existsSync(pilotBackupPath)) {
    fs.copyFileSync(acceptedPath, pilotBackupPath);
  }

  fs.writeFileSync(acceptedPath, wave3.join("\n") + "\n");
  fs.copyFileSync(acceptedPath, path.join(outDir, "accepted-candidate-ids.txt"));

  const batchTag = `PC05D_WAVE3_${runId}`;
  const cmd = [
    "npx tsx scripts/pc05-product-packaging-backfill-staging-execute.ts",
    `--run-id=${runId}`,
    `--dry-run-id=${DRY_RUN_ID}`,
    `--approval-path=${APPROVAL_PATH}`,
    `--out-base=${OUT_BASE}`,
    `--batch-tag=${batchTag}`,
    "--force-needs-review",
    apply ? "--apply" : "",
  ]
    .filter(Boolean)
    .join(" ");

  execSync(cmd, { cwd: process.cwd(), stdio: "inherit" });

  if (fs.existsSync(pilotBackupPath)) {
    fs.copyFileSync(pilotBackupPath, acceptedPath);
  }

  const manifestPath = path.join(outDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    m.prompt = "PC05-WAVE3-EXECUTE — PACKAGING BACKFILL STAGING WAVE 3 ONLY";
    m.wave3_candidate_count = wave3.length;
    m.manual_review_plan_run = MANUAL_REVIEW_PLAN_RUN;
    m.inserted_version_status = "needs_review";
    m.parity_verify_run = findParityVerifyRun();
    m.staging_ref = "eiqfaapyumhixxoeltgu";
    m.original_not_targeted = true;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  }

  const approvalProof = path.join(outDir, "approval-proof.md");
  if (fs.existsSync(approvalProof)) {
    const extra = [
      "",
      "## Preconditions",
      "",
      `- Full parity verify: **PASS** (\`${findParityVerifyRun()}\`, ${EXPECTED_PARITY_TOTAL} governed)`,
      `- Manual-review plan: \`${MANUAL_REVIEW_PLAN_RUN}\``,
      `- Wave3 candidates: **${wave3.length}** (\`wave3_proposed_ids\` only)`,
      `- Target: staging \`eiqfaapyumhixxoeltgu\` only`,
      `- Original \`kxsvedvpjldygtdbylsy\`: **not targeted**`,
    ].join("\n");
    fs.appendFileSync(approvalProof, extra);
  }

  const manifest = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
    : {};

  console.log(
    JSON.stringify(
      {
        ok: manifest.ok ?? false,
        outDir,
        approval_valid: approval.valid,
        wave3_candidate_count: wave3.length,
        inserted_profiles: manifest.inserted_profiles,
        inserted_versions: manifest.inserted_versions,
        inserted_version_status: "needs_review",
        batch_tag: batchTag,
        rollback: path.join(outDir, "rollback.sql"),
      },
      null,
      2,
    ),
  );
  process.exit(manifest.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
