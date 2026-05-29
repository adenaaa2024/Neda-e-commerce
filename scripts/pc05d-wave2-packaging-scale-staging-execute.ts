/**
 * PC05D-WAVE2 — Scale Wave 2 staging execute (200 PIM case-pack rows).
 *
 *   npx tsx scripts/pc05d-wave2-packaging-scale-staging-execute.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PLAN_RUN = "20260526T181000Z";
const DRY_RUN_ID = "20260523T220000Z";
const WAVE1_ACTIVATE_RUN = "20260526T193000Z";
const PC05E_VERIFY_RUN = "20260526T201000Z";
const DRY_RUN_DIR = `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_ID}`;
const PLAN_WAVE_FILE = `.cursor/audit-reports/pc05d-packaging-backfill-scale-staging-plan/${PLAN_RUN}/remaining-safe-candidates.json`;
const APPROVAL_PATH = ".cursor/operator-approvals/product-packaging-backfill-pc05d-scale-execute-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc05d-wave2-packaging-scale-staging-execute";
const PILOT_BACKUP = "accepted-candidate-ids.pilot191.txt";
const EXPECTED_WAVE2 = 200;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function preconditionOk(): string[] {
  const blockers: string[] = [];
  const activateManifest = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05d-wave1-activate-staging",
    WAVE1_ACTIVATE_RUN,
    "manifest.json",
  );
  if (!fs.existsSync(activateManifest)) {
    blockers.push(`Missing Wave1 activate proof: ${WAVE1_ACTIVATE_RUN}`);
  } else {
    try {
      const m = JSON.parse(fs.readFileSync(activateManifest, "utf8")) as { ok?: boolean; activated_count?: number };
      if (!m.ok || (m.activated_count ?? 0) !== 50) blockers.push("Wave1 activate must be PASS 50/50");
    } catch {
      blockers.push("Invalid Wave1 activate manifest");
    }
  }

  const verifyManifest = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05e-wave1-original-verify",
    PC05E_VERIFY_RUN,
    "manifest.json",
  );
  if (!fs.existsSync(verifyManifest)) {
    blockers.push(`Missing PC05E verify proof: ${PC05E_VERIFY_RUN}`);
  } else {
    try {
      const v = JSON.parse(fs.readFileSync(verifyManifest, "utf8")) as { ok?: boolean; parity_pass?: boolean };
      if (!v.ok || !v.parity_pass) blockers.push("PC05E Wave1 original verify must be PASS");
    } catch {
      blockers.push("Invalid PC05E verify manifest");
    }
  }
  return blockers;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const preBlockers = preconditionOk();
  if (preBlockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), preBlockers.map((b) => `- ${b}`).join("\n"));
    console.log(JSON.stringify({ ok: false, outDir, blockers: preBlockers }, null, 2));
    process.exit(1);
  }

  const wavePlan = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLAN_WAVE_FILE), "utf8")) as {
    wave2_candidate_ids: string[];
  };
  const wave2 = wavePlan.wave2_candidate_ids ?? [];
  if (wave2.length !== EXPECTED_WAVE2) {
    console.error(JSON.stringify({ ok: false, error: `Expected ${EXPECTED_WAVE2} wave2 ids, got ${wave2.length}` }));
    process.exit(1);
  }

  const dryRunDir = path.join(process.cwd(), DRY_RUN_DIR);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");
  const pilotBackupPath = path.join(dryRunDir, PILOT_BACKUP);

  if (fs.existsSync(acceptedPath) && !fs.existsSync(pilotBackupPath)) {
    fs.copyFileSync(acceptedPath, pilotBackupPath);
  }

  fs.writeFileSync(acceptedPath, wave2.join("\n") + "\n");
  fs.copyFileSync(acceptedPath, path.join(outDir, "accepted-candidate-ids.txt"));

  const batchTag = `PC05D_WAVE2_${runId}`;
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
    m.prompt = "PC05D-WAVE2-EXECUTE — PACKAGING BACKFILL SCALE STAGING WAVE 2 ONLY";
    m.wave2_candidate_count = wave2.length;
    m.plan_run_id = PLAN_RUN;
    m.inserted_version_status = "needs_review";
    m.wave1_activate_run = WAVE1_ACTIVATE_RUN;
    m.pc05e_verify_run = PC05E_VERIFY_RUN;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  }

  const approvalProof = path.join(outDir, "approval-proof.md");
  if (fs.existsSync(approvalProof)) {
    const extra = [
      "",
      "## Preconditions",
      "",
      `- Wave1 activate: \`${WAVE1_ACTIVATE_RUN}\` PASS`,
      `- PC05E verify: \`${PC05E_VERIFY_RUN}\` PASS`,
      `- Plan: \`${PLAN_RUN}\``,
      `- Wave2 candidates: **${wave2.length}**`,
    ].join("\n");
    fs.appendFileSync(approvalProof, extra);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        wave2_count: wave2.length,
        batch_tag: batchTag,
        inserted_version_status: "needs_review",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
