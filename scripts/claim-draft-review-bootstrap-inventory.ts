/**
 * NEXT-CLAIM-DRAFT-REVIEW-BOOTSTRAP — Read-only inventory of amazon_removals drafts vs claim_review_work_items.
 *
 *   npx tsx scripts/claim-draft-review-bootstrap-inventory.ts --org-id=<uuid>
 *   npx tsx scripts/claim-draft-review-bootstrap-inventory.ts --org-id=<uuid> --run-id=myRun
 *
 * SELECT only. Writes local audit artifacts under:
 *   .cursor/audit-reports/next-claim-draft-review-bootstrap/<run_id>/
 *
 * Does NOT insert/update claim_candidate_drafts or claim_review_work_items.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES,
  mapDraftLifecycleToWorkItemFields,
} from "../lib/claim-review-workflow-bootstrap";
import { isUuidString } from "../lib/uuid";

const SCRIPT_VERSION = "claim-draft-review-bootstrap-readonly-v1";
const PAGE = 800;
const SAMPLE_MISSING = 100;

type DraftRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  lifecycle_status: string;
  blocker_reasons: unknown;
  evidence_status: string;
};

type WorkItemRow = {
  id: string;
  draft_id: string;
  workflow_state: string;
  review_queue: string;
  priority: string;
};

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isoRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function bump(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

function mapToSorted(m: Map<string, number>, keyName: string): Record<string, number>[] {
  return Array.from(m.entries())
    .map(([k, count]) => ({ [keyName]: k, count }))
    .sort((a, b) => (b.count as number) - (a.count as number)) as Record<string, number>[];
}

async function fetchAllRemovalsDrafts(client: SupabaseClient, orgId: string): Promise<DraftRow[]> {
  const out: DraftRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidate_drafts")
      .select("id, organization_id, store_id, source_table, lifecycle_status, blocker_reasons, evidence_status")
      .eq("organization_id", orgId)
      .eq("source_table", "amazon_removals")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`claim_candidate_drafts: ${error.message}`);
    const batch = (data ?? []) as DraftRow[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

type WorkItemFetchResult = {
  byDraft: Map<string, WorkItemRow>;
  table_present: boolean;
  table_error: string | null;
};

async function probeWorkItemsTable(client: SupabaseClient, orgId: string): Promise<boolean> {
  const { error } = await client.from("claim_review_work_items").select("id").eq("organization_id", orgId).limit(1);
  if (!error) return true;
  const msg = error.message ?? "";
  if (msg.includes("Could not find the table") || msg.includes("does not exist") || error.code === "42P01") return false;
  throw new Error(`claim_review_work_items probe: ${msg}`);
}

async function fetchWorkItemsForDrafts(
  client: SupabaseClient,
  orgId: string,
  draftIds: string[],
): Promise<WorkItemFetchResult> {
  const byDraft = new Map<string, WorkItemRow>();
  const tablePresent = await probeWorkItemsTable(client, orgId);
  if (!tablePresent) {
    return { byDraft, table_present: false, table_error: "table not in schema cache / migration not applied" };
  }
  const CHUNK = 200;
  for (let i = 0; i < draftIds.length; i += CHUNK) {
    const slice = draftIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("claim_review_work_items")
      .select("id, draft_id, workflow_state, review_queue, priority")
      .eq("organization_id", orgId)
      .in("draft_id", slice);
    if (error) throw new Error(`claim_review_work_items: ${error.message}`);
    for (const row of (data ?? []) as WorkItemRow[]) {
      if (row.draft_id) byDraft.set(row.draft_id, row);
    }
  }
  return { byDraft, table_present: true, table_error: null };
}

function parseArgs(argv: string[]): { orgId: string | null; runId: string | null } {
  let orgId: string | null = null;
  let runId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
  }
  return { orgId, runId };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, runId: runIdArg } = parseArgs(process.argv.slice(2));
  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid>");
    process.exitCode = 1;
    return;
  }

  const runId = runIdArg ?? `claim-draft-review-bootstrap-${isoRunId()}`;
  const outDir = path.resolve(process.cwd(), ".cursor", "audit-reports", "next-claim-draft-review-bootstrap", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const client = createServiceClient();
  const drafts = await fetchAllRemovalsDrafts(client, orgId);
  const draftIds = drafts.map((d) => d.id);
  const { byDraft: workItemsByDraft, table_present: workItemsTablePresent, table_error: workItemsTableError } =
    await fetchWorkItemsForDrafts(client, orgId, draftIds);

  const eligibleSet = new Set<string>(BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES);
  const lifecycleAll = new Map<string, number>();
  const lifecycleEligible = new Map<string, number>();
  const lifecycleIneligible = new Map<string, number>();
  const queueExisting = new Map<string, number>();
  const workflowExisting = new Map<string, number>();
  const priorityExisting = new Map<string, number>();
  const evidenceAll = new Map<string, number>();

  const missingEligible: DraftRow[] = [];
  const missingIneligible: DraftRow[] = [];
  const projectedQueueIfBootstrap = new Map<string, number>();
  const projectedStateIfBootstrap = new Map<string, number>();

  for (const d of drafts) {
    bump(lifecycleAll, d.lifecycle_status);
    bump(evidenceAll, d.evidence_status);
    const wi = workItemsByDraft.get(d.id);
    if (wi) {
      bump(queueExisting, wi.review_queue);
      bump(workflowExisting, wi.workflow_state);
      bump(priorityExisting, wi.priority);
    }
    if (eligibleSet.has(d.lifecycle_status)) {
      bump(lifecycleEligible, d.lifecycle_status);
      if (!wi) {
        missingEligible.push(d);
        const mapped = mapDraftLifecycleToWorkItemFields(d.lifecycle_status, d.blocker_reasons);
        bump(projectedQueueIfBootstrap, mapped.review_queue);
        bump(projectedStateIfBootstrap, mapped.workflow_state);
      }
    } else {
      bump(lifecycleIneligible, d.lifecycle_status);
      if (!wi) missingIneligible.push(d);
    }
  }

  const bootstrapExecuteNeeded = missingEligible.length > 0;

  const summary = {
    prompt_name: "NEXT-CLAIM-DRAFT-REVIEW-BOOTSTRAP",
    run_id: runId,
    generated_at_utc: new Date().toISOString(),
    script_version: SCRIPT_VERSION,
    organization_id: orgId,
    source_table_filter: "amazon_removals",
    counts: {
      total_removal_drafts: drafts.length,
      work_items_existing: workItemsByDraft.size,
      work_items_missing: drafts.length - workItemsByDraft.size,
      bootstrap_eligible_drafts: drafts.filter((d) => eligibleSet.has(d.lifecycle_status)).length,
      bootstrap_eligible_missing_work_item: missingEligible.length,
      ineligible_drafts_missing_work_item: missingIneligible.length,
      bootstrap_execute_needed: bootstrapExecuteNeeded,
    },
    bootstrap_eligible_lifecycles: [...BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES],
    schema: {
      claim_review_work_items_table_present: workItemsTablePresent,
      claim_review_work_items_table_error: workItemsTableError,
    },
  };

  fs.writeFileSync(path.join(outDir, "00-inventory-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(
    path.join(outDir, "01-lifecycle-distribution.json"),
    JSON.stringify(
      {
        all_drafts: mapToSorted(lifecycleAll, "lifecycle_status"),
        bootstrap_eligible: mapToSorted(lifecycleEligible, "lifecycle_status"),
        bootstrap_ineligible: mapToSorted(lifecycleIneligible, "lifecycle_status"),
        evidence_status: mapToSorted(evidenceAll, "evidence_status"),
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "02-queue-distribution.json"),
    JSON.stringify(
      {
        existing_work_items: {
          review_queue: mapToSorted(queueExisting, "review_queue"),
          workflow_state: mapToSorted(workflowExisting, "workflow_state"),
          priority: mapToSorted(priorityExisting, "priority"),
        },
        projected_if_bootstrap_missing_only: {
          review_queue: mapToSorted(projectedQueueIfBootstrap, "review_queue"),
          workflow_state: mapToSorted(projectedStateIfBootstrap, "workflow_state"),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "03-bootstrap-gap.json"),
    JSON.stringify(
      {
        bootstrap_execute_needed: bootstrapExecuteNeeded,
        missing_eligible_count: missingEligible.length,
        missing_by_lifecycle: mapToSorted(
          missingEligible.reduce((m, d) => {
            bump(m, d.lifecycle_status);
            return m;
          }, new Map<string, number>()),
          "lifecycle_status",
        ),
        ineligible_missing_work_item_count: missingIneligible.length,
        note: "Bootstrap only inserts for eligible lifecycles (draft, blocked, needs_evidence, needs_product_link, ready_for_review). Terminal drafts do not get work items via bootstrap.",
      },
      null,
      2,
    ),
    "utf8",
  );

  const csvHeaders = "draft_id,lifecycle_status,evidence_status,has_work_item,bootstrap_eligible,projected_review_queue,projected_workflow_state";
  const csvLines = [csvHeaders];
  for (const d of missingEligible.slice(0, SAMPLE_MISSING)) {
    const mapped = mapDraftLifecycleToWorkItemFields(d.lifecycle_status, d.blocker_reasons);
    csvLines.push(
      [d.id, d.lifecycle_status, d.evidence_status, "no", "yes", mapped.review_queue, mapped.workflow_state]
        .map((x) => (x.includes(",") ? `"${x.replace(/"/g, '""')}"` : x))
        .join(","),
    );
  }
  fs.writeFileSync(path.join(outDir, "04-missing-work-item-sample.csv"), csvLines.join("\n") + "\n", "utf8");

  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    `# Validation — NEXT-CLAIM-DRAFT-REVIEW-BOOTSTRAP

| Constraint | Result |
|------------|--------|
| DB writes | **none** — SELECT only |
| claim_candidate_drafts insert/update | **no** |
| claim_review_work_items insert/update | **no** |
| claim_candidates mutation | **no** |
| source_row_id repair | **no** |
| filing agent | **no** |
| AI / external API | **no** |

Org: \`${orgId}\`  
Script: \`${SCRIPT_VERSION}\`
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "bootstrap-recommendation.md"),
    `# Bootstrap recommendation

## Inventory result

- Total amazon_removals drafts: **${drafts.length}**
- Work items existing: **${workItemsByDraft.size}**
- Work items missing (all lifecycles): **${drafts.length - workItemsByDraft.size}**
- Bootstrap-eligible drafts missing work item: **${missingEligible.length}**

## Schema note

- \`claim_review_work_items\` table present: **${workItemsTablePresent}**
${workItemsTableError ? `- Probe error: ${workItemsTableError}` : ""}
${!workItemsTablePresent ? "- Apply migration \`20260815160000_claim_review_work_items.sql\` before bootstrap execute." : ""}

## Execute bootstrap later?

**${bootstrapExecuteNeeded ? "Yes — when review workflow is prioritized, work-items migration is applied, and product path allows claim ops writes." : "No — all bootstrap-eligible removals drafts already have work items (or none are eligible)."}**

If execute is approved later (separate prompt):

\`\`\`bash
npx tsx scripts/claim-review-workitem-bootstrap.ts --org-id=${orgId} --execute --write-artifacts
\`\`\`

Precondition per NEXT-CLAIM-22-HOLD: staging load is not needed (\`would_insert=0\`); focus remains product propagation before operator review volume.

Upstream: [NEXT-CLAIM-22-HOLD](../../next-claim-22-hold/20260515T081000Z-no-op-decision/)
`,
    "utf8",
  );

  const manifest = {
    prompt_name: "NEXT-CLAIM-DRAFT-REVIEW-BOOTSTRAP",
    run_id: runId,
    created_at_utc: new Date().toISOString(),
    mode: "read_only_inventory",
    output_directory: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
    script: "scripts/claim-draft-review-bootstrap-inventory.ts",
    script_version: SCRIPT_VERSION,
    organization_id: orgId,
    artifacts: [
      "00-inventory-summary.json",
      "01-lifecycle-distribution.json",
      "02-queue-distribution.json",
      "03-bootstrap-gap.json",
      "04-missing-work-item-sample.csv",
      "validation-results.md",
      "bootstrap-recommendation.md",
      "manifest.json",
    ],
    summary: summary.counts,
    schema: summary.schema,
    validation: {
      db_writes: false,
      claim_candidate_drafts_mutated: false,
      claim_review_work_items_mutated: false,
      claim_candidates_mutated: false,
      source_row_id_repairs: false,
      filing_agent_run: false,
      ai_or_external_api_calls: false,
      local_artifacts_only: true,
    },
    upstream: {
      next_claim_22_hold: ".cursor/audit-reports/next-claim-22-hold/20260515T081000Z-no-op-decision/",
      next_claim_21: ".cursor/audit-reports/next-claim-21/claim21-real-org-removals-current-source/",
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`NEXT-CLAIM-DRAFT-REVIEW-BOOTSTRAP complete. Output: ${outDir}`);
  console.log(JSON.stringify(summary.counts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
