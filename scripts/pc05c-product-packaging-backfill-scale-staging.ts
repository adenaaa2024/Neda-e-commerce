/**
 * PC05C — Scale packaging backfill: expand accepted list, execute, activate (staging).
 *
 *   npx tsx scripts/pc05c-product-packaging-backfill-scale-staging.ts
 *   npx tsx scripts/pc05c-product-packaging-backfill-scale-staging.ts --apply
 */
import { execSync } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const DRY_RUN_ID = "20260523T220000Z";
const DRY_RUN_DIR = `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_ID}`;
const EXECUTE_APPROVAL = ".cursor/operator-approvals/product-packaging-backfill-pc05c-scale-execute-approval.md";
const ACTIVATE_APPROVAL = ".cursor/operator-approvals/product-packaging-backfill-pc05c-scale-activate-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc05c-product-packaging-backfill-scale-staging";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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

async function buildAcceptedAfiNoConflict(dryRunDir: string): Promise<string[]> {
  const csvPath = path.join(process.cwd(), dryRunDir, "candidate-rows.csv");
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
  const ids: string[] = [];
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (first) {
      headers = cols;
      first = false;
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    const id = row.candidate_id ?? "";
    if (!id.startsWith("afi-")) continue;
    if ((row.blockers ?? "").includes("source_conflict_afi_mfba")) continue;
    if (row.recommended_action === "blocked") continue;
    ids.push(id);
  }
  return ids;
}

function approvalOk(file: string, flag: string): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  return /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) && new RegExp(`${flag}\\s*=\\s*true`, "i").test(text);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const skipExecute = process.argv.includes("--skip-execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== "feature/product-canonicalization-v2") blockers.push("Wrong branch");

  const executeOk = approvalOk(EXECUTE_APPROVAL, "APPROVED_PRODUCT_PACKAGING_BACKFILL_SCALE_EXECUTE");
  const activateOk = approvalOk(ACTIVATE_APPROVAL, "APPROVED_PRODUCT_PACKAGING_BACKFILL_SCALE_ACTIVATE");
  if (!executeOk) blockers.push("Scale execute approval not valid");
  if (apply && !activateOk) blockers.push("Scale activate approval not valid (required for --apply)");

  const dryRunDir = path.join(process.cwd(), DRY_RUN_DIR);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");
  const pilotBackup = path.join(dryRunDir, "accepted-candidate-ids.pilot.txt");

  if (fs.existsSync(acceptedPath) && !fs.existsSync(pilotBackup)) {
    fs.copyFileSync(acceptedPath, pilotBackup);
  }

  const acceptedIds = await buildAcceptedAfiNoConflict(DRY_RUN_DIR);
  fs.writeFileSync(acceptedPath, acceptedIds.join("\n") + "\n");
  fs.writeFileSync(
    path.join(outDir, "accepted-candidate-ids-expanded.txt"),
    acceptedIds.join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "expand-summary.md"),
    [
      "# PC05C — Expanded accepted list",
      "",
      `Filter: \`afi-*\` without \`source_conflict_afi_mfba\`, not blocked`,
      `Count: **${acceptedIds.length}**`,
      `Written to: \`${acceptedPath}\``,
      pilotBackup ? `Pilot backup: \`accepted-candidate-ids.pilot.txt\`` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  let executeRunId = "";
  let executeResult: Record<string, unknown> = {};
  let activateRunId = "";
  let activateResult: Record<string, unknown> = {};

  if (apply && blockers.length === 0) {
    executeRunId = runId;
    const executeManifestPath = path.join(
      process.cwd(),
      ".cursor/audit-reports/pc05-product-packaging-backfill-staging-execute",
      executeRunId,
      "manifest.json",
    );

    if (skipExecute && fs.existsSync(executeManifestPath)) {
      executeResult = JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as Record<string, unknown>;
    } else {
      execSync(
        `npx tsx scripts/pc05-product-packaging-backfill-staging-execute.ts --apply --dry-run-id=${DRY_RUN_ID} --run-id=${executeRunId} --approval-path=${EXECUTE_APPROVAL}`,
        { encoding: "utf8", cwd: process.cwd(), stdio: ["inherit", "pipe", "inherit"] },
      );
      executeResult = JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as Record<string, unknown>;
    }

    const insertSummaryPath = path.join(
      process.cwd(),
      ".cursor/audit-reports/pc05-product-packaging-backfill-staging-execute",
      executeRunId,
      "insert-summary.json",
    );
    const summary = JSON.parse(fs.readFileSync(insertSummaryPath, "utf8")) as {
      insertedIds: { version_id: string }[];
    };
    const versionIds = summary.insertedIds.map((r) => r.version_id);
    fs.writeFileSync(
      path.join(path.dirname(insertSummaryPath), "accepted-version-ids.txt"),
      versionIds.join("\n") + "\n",
    );
    fs.writeFileSync(path.join(outDir, "accepted-version-ids-scale.txt"), versionIds.join("\n") + "\n");

    if (versionIds.length === 0) {
      blockers.push("Scale execute inserted 0 new profiles — nothing to activate");
    } else {
      activateRunId = `${runId}-activate`;
      execSync(
        `npx tsx scripts/pc05b-product-packaging-backfill-review-activate-staging.ts --apply --execute-run-id=${executeRunId} --run-id=${activateRunId} --approval-path=${ACTIVATE_APPROVAL}`,
        { encoding: "utf8", cwd: process.cwd(), stdio: ["inherit", "pipe", "inherit"] },
      );
      const activateManifestPath = path.join(
        process.cwd(),
        ".cursor/audit-reports/pc05b-product-packaging-backfill-review-activate-staging",
        activateRunId,
        "manifest.json",
      );
      activateResult = JSON.parse(fs.readFileSync(activateManifestPath, "utf8")) as Record<string, unknown>;
    }
  }

  const ok =
    apply &&
    blockers.length === 0 &&
    Boolean(executeResult.ok) &&
    (Number(executeResult.inserted_profiles ?? 0) >= 0) &&
    Boolean(activateResult.ok);

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05C — PRODUCT PACKAGING BACKFILL SCALE",
        run_id: runId,
        expanded_accepted_count: acceptedIds.length,
        execute_run_id: executeRunId || null,
        activate_run_id: activateRunId || null,
        execute_result: executeResult,
        activate_result: activateResult,
        blockers,
        ok,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.",
  );

  console.log(
    JSON.stringify(
      {
        ok,
        outDir,
        expanded_accepted: acceptedIds.length,
        execute_run_id: executeRunId,
        activate_run_id: activateRunId,
        execute: executeResult,
        activate: activateResult,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : apply ? 1 : blockers.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
