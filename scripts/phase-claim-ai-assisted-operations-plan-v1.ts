/**
 * PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1
 *   npx tsx scripts/phase-claim-ai-assisted-operations-plan-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_AI_ASSISTED_OPERATIONS_PLAN_V1,
  buildClaimAiAssistedOperationsPlanV1,
} from "../lib/claims/ai/claim-ai-assisted-operations-plan-v1";

const OUT = ".cursor/audit-reports/phase-claim-ai-assisted-operations-plan-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function main(): void {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const scannerBefore = scannerGitStatus();
  const plan = buildClaimAiAssistedOperationsPlanV1();
  const scannerAfter = scannerGitStatus();

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    execSync("npx tsx scripts/smoke-claim-ai-assisted-operations-plan-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const phasePass =
    plan.SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY &&
    plan.SAFE_TO_BUILD_AI_REFERENCE_GAP_DETECTOR &&
    plan.SAFE_TO_BUILD_AI_DRAFT_HELPER &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    scannerBefore === scannerAfter;

  const result = {
    phase: "PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1",
    run_id: rid,
    mode: "ai-feature-planning-only",
    ...plan,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    phase_pass: phasePass,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "recommended-ai-features.json"),
    JSON.stringify(plan.recommended_ai_features, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "rejected-ai-features.json"),
    JSON.stringify(plan.rejected_ai_features, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1

- Run: \`${rid}\`
- Mode: **AI feature planning only** (no DB writes, no model calls)
- Recommended features: **${plan.recommended_ai_features.length}**
- Rejected patterns: **${plan.rejected_ai_features.length}**
- SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY: **${plan.SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY}**
- SAFE_TO_BUILD_AI_REFERENCE_GAP_DETECTOR: **${plan.SAFE_TO_BUILD_AI_REFERENCE_GAP_DETECTOR}**
- SAFE_TO_BUILD_AI_DRAFT_HELPER: **${plan.SAFE_TO_BUILD_AI_DRAFT_HELPER}**

## Implementation order
${plan.implementation_order.map((l) => `- ${l}`).join("\n")}

## NEXT_PROMPT
\`${plan.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main();
