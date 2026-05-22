/**
 * NEXT-CLAIM-EVIDENCE-04 — Persist evidence graph for ONE draft (gated).
 *
 *   npx tsx scripts/claim-evidence-persist-one.ts --org-id=<uuid> --draft-id=<uuid>
 *   npx tsx scripts/claim-evidence-persist-one.ts --org-id=<uuid> --candidate-id=<uuid>
 *   npx tsx scripts/claim-evidence-persist-one.ts --org-id=<uuid> --draft-id=<uuid> --dry-run
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  assertClaimEvidence04StagingUrl,
  isClaimEvidence04WriteApproved,
} from "../lib/claim-evidence-persist-approval";
import { persistClaimEvidence04ForDraft } from "../lib/claim-evidence-persist";
import {
  fetchDraftRow,
  resolveDraftForCandidate,
} from "../lib/claim-evidence-preview";
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
  candidateId: string | null;
  dryRun: boolean;
  runId: string | null;
} {
  let orgId: string | null = null;
  let draftId: string | null = null;
  let candidateId: string | null = null;
  let dryRun = false;
  let runId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--draft-id=")) draftId = a.slice("--draft-id=".length).trim() || null;
    if (a.startsWith("--candidate-id=")) candidateId = a.slice("--candidate-id=".length).trim() || null;
    if (a === "--dry-run") dryRun = true;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
  }
  return { orgId, draftId, candidateId, dryRun, runId };
}

function isoRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, draftId: draftIdArg, candidateId, dryRun, runId: runIdArg } = parseArgs(
    process.argv.slice(2),
  );

  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid>");
    process.exitCode = 1;
    return;
  }
  if (draftIdArg && candidateId) {
    console.error("Provide only one of --draft-id or --candidate-id.");
    process.exitCode = 1;
    return;
  }
  if (!draftIdArg && !candidateId) {
    console.error("Required: --draft-id=<uuid> OR --candidate-id=<uuid>");
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
  let draftId = draftIdArg;
  let claimCandidateId: string | null = candidateId;

  if (candidateId) {
    if (!isUuidString(candidateId)) {
      console.error("Invalid --candidate-id");
      process.exitCode = 1;
      return;
    }
    const { data: cand, error: cErr } = await client
      .from("claim_candidates")
      .select("id, organization_id, store_id, source_table, source_row_id, sku")
      .eq("id", candidateId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (cErr || !cand) {
      console.error(cErr?.message ?? "Candidate not found.");
      process.exitCode = 1;
      return;
    }
    const row = cand as unknown as Record<string, unknown>;
    const resolved = await resolveDraftForCandidate(client, orgId, {
      id: candidateId,
      source_table: row.source_table != null ? String(row.source_table) : null,
      source_row_id: row.source_row_id != null ? String(row.source_row_id) : null,
      sku: row.sku != null ? String(row.sku) : null,
      store_id: row.store_id != null ? String(row.store_id) : null,
    });
    if (!resolved) {
      console.error("Could not resolve draft for candidate.");
      process.exitCode = 1;
      return;
    }
    const realDraft = await fetchDraftRow(client, orgId, resolved.id);
    if (!realDraft) {
      console.error(
        "No claim_candidate_drafts row for resolved id — persist requires a real draft FK.",
      );
      process.exitCode = 1;
      return;
    }
    draftId = realDraft.id;
    claimCandidateId = candidateId;
  }

  if (!draftId || !isUuidString(draftId)) {
    console.error("Invalid draft id.");
    process.exitCode = 1;
    return;
  }

  const draft = await fetchDraftRow(client, orgId, draftId);
  if (!draft) {
    console.error("Draft not found in claim_candidate_drafts.");
    process.exitCode = 1;
    return;
  }

  const result = await persistClaimEvidence04ForDraft(client, draft, {
    organizationId: orgId,
    draftId,
    claimCandidateId,
    dryRun,
  });

  const runId = runIdArg ?? isoRunId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/next-claim-evidence-04",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "persist-result.json"), JSON.stringify(result, null, 2), "utf8");

  console.log(JSON.stringify({ run_id: runId, output_directory: outDir, ...result }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
