/**
 * PC05D-WAVE1 — Scale Wave 1 staging execute (50 PIM case-pack rows).
 *
 *   npx tsx scripts/pc05d-wave1-packaging-scale-staging-execute.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PLAN_RUN = "20260526T181000Z";
const DRY_RUN_ID = "20260523T220000Z";
const DRY_RUN_DIR = `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_ID}`;
const PLAN_WAVE_FILE = `.cursor/audit-reports/pc05d-packaging-backfill-scale-staging-plan/${PLAN_RUN}/remaining-safe-candidates.json`;
const APPROVAL_PATH = ".cursor/operator-approvals/product-packaging-backfill-pc05d-scale-execute-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc05d-wave1-packaging-scale-staging-execute";
const PILOT_BACKUP = "accepted-candidate-ids.pilot191.txt";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const wavePlan = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLAN_WAVE_FILE), "utf8")) as {
    wave1_candidate_ids: string[];
  };
  const wave1 = wavePlan.wave1_candidate_ids ?? [];
  if (wave1.length !== 50) {
    console.error(JSON.stringify({ ok: false, error: `Expected 50 wave1 ids, got ${wave1.length}` }));
    process.exit(1);
  }

  const dryRunDir = path.join(process.cwd(), DRY_RUN_DIR);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");
  const pilotBackupPath = path.join(dryRunDir, PILOT_BACKUP);

  if (fs.existsSync(acceptedPath) && !fs.existsSync(pilotBackupPath)) {
    fs.copyFileSync(acceptedPath, pilotBackupPath);
  }

  fs.writeFileSync(acceptedPath, wave1.join("\n") + "\n");
  fs.copyFileSync(acceptedPath, path.join(outDir, "accepted-candidate-ids.txt"));

  const batchTag = `PC05D_WAVE1_${runId}`;
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
    m.prompt = "PC05D-WAVE1 — PACKAGING BACKFILL SCALE STAGING WAVE 1 ONLY";
    m.wave1_candidate_count = wave1.length;
    m.plan_run_id = PLAN_RUN;
    m.inserted_version_status = "needs_review";
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  }

  const approvalProof = path.join(outDir, "approval-proof.md");
  if (!fs.existsSync(approvalProof)) {
    fs.writeFileSync(
      approvalProof,
      [
        "# Approval proof — PC05D Wave 1",
        "",
        `File: \`${APPROVAL_PATH}\``,
        "",
        "See execute-result.md and manifest.json.",
      ].join("\n"),
    );
  }

  console.log(JSON.stringify({ ok: true, outDir, wave1_count: wave1.length, batch_tag: batchTag }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
