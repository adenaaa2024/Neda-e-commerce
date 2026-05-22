/**
 * NEXT-CLAIM-EVIDENCE-04 — Rollback persisted evidence graph for ONE draft generation.
 *
 *   npx tsx scripts/claim-evidence-rollback-one.ts --org-id=<uuid> --draft-id=<uuid>
 *   npx tsx scripts/claim-evidence-rollback-one.ts --org-id=<uuid> --draft-id=<uuid> --generation-id=<uuid>
 *   npx tsx scripts/claim-evidence-rollback-one.ts --org-id=<uuid> --draft-id=<uuid> --dry-run
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  assertClaimEvidence04StagingUrl,
  isClaimEvidence04WriteApproved,
} from "../lib/claim-evidence-persist-approval";
import { rollbackClaimEvidence04ForDraft } from "../lib/claim-evidence-persist";
import { isUuidString } from "../lib/uuid";

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function parseArgs(argv: string[]): {
  orgId: string | null;
  draftId: string | null;
  generationId: string | null;
  dryRun: boolean;
  runId: string | null;
} {
  let orgId: string | null = null;
  let draftId: string | null = null;
  let generationId: string | null = null;
  let dryRun = false;
  let runId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--draft-id=")) draftId = a.slice("--draft-id=".length).trim() || null;
    if (a.startsWith("--generation-id=")) generationId = a.slice("--generation-id=".length).trim() || null;
    if (a === "--dry-run") dryRun = true;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
  }
  return { orgId, draftId, generationId, dryRun, runId };
}

function isoRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, draftId, generationId, dryRun, runId: runIdArg } = parseArgs(process.argv.slice(2));

  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid>");
    process.exitCode = 1;
    return;
  }
  if (!draftId || !isUuidString(draftId)) {
    console.error("Required: --draft-id=<uuid>");
    process.exitCode = 1;
    return;
  }
  if (generationId && !isUuidString(generationId)) {
    console.error("Invalid --generation-id");
    process.exitCode = 1;
    return;
  }

  if (!dryRun && !isClaimEvidence04WriteApproved()) {
    console.error("BLOCKED: APPROVED_TO_WRITE_CLAIM_EVIDENCE_04_DEV_STAGING=true not set.");
    process.exitCode = 1;
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exitCode = 1;
    return;
  }
  try {
    assertClaimEvidence04StagingUrl(url);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
    return;
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const result = await rollbackClaimEvidence04ForDraft(client, {
    organizationId: orgId,
    draftId,
    generationId,
    dryRun,
  });

  const runId = runIdArg ?? isoRunId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/next-claim-evidence-04",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "rollback-result.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );

  console.log(JSON.stringify({ run_id: runId, output_directory: outDir, ...result }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
