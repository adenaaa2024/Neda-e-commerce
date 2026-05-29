/**
 * REMOVAL BACKFILL PRIORITY TODAY-BACKWARD PLAN (read-only)
 *
 *   npx tsx scripts/removal-backfill-priority-today-backward-plan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const OUT_BASE = ".cursor/audit-reports/removal-backfill-priority-today-backward-plan";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const TODAY = "2026-05-28";

/** Domain-synced coverage (preserved). */
const COVERED_SYNCED = [
  {
    label: "bulk_sp_api",
    start: "2025-12-26T00:00:00.000Z",
    end: "2026-04-21T23:59:59.999Z",
    status: "fetch_and_domain_sync",
  },
  {
    label: "chunk1",
    start: "2025-08-27T00:00:00.000Z",
    end: "2025-08-31T23:59:59.999Z",
    status: "fetch_and_domain_sync",
    order_upload_id: "924ce268-8840-497b-8da4-c9cb7879afbf",
    shipment_upload_id: "0911b550-b87a-4137-aa48-dd0093c5645b",
    execute_ref: "removal-9-month-backfill-domain-sync-chunk1/20260528T214520Z",
  },
] as const;

/** Fetch-only (raw uploads ready; domain not synced). */
const FETCHED_ONLY = [
  {
    label: "chunk2",
    start: "2025-09-01T00:00:00.000Z",
    end: "2025-09-30T23:59:59.999Z",
    status: "fetch_only",
    order_upload_id: "06ddd21c-6eee-4e44-907e-c2586ebdde51",
    shipment_upload_id: "3e682300-5ba3-481b-9895-69607069d933",
    order_rows: 356,
    shipment_rows: 2721,
    execute_ref: "removal-9-month-backfill-fetch-chunk2/20260528T000000Z",
  },
] as const;

type Batch = {
  batch_id: string;
  priority_tier: "A_recent" | "B_historical";
  sort_order: number;
  action: "fetch_and_sync" | "domain_sync_only";
  window_start: string;
  window_end: string;
  fetch_prompt: string | null;
  sync_prompt: string;
  order_upload_id?: string;
  shipment_upload_id?: string;
  api_report_creates: number;
  notes?: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const targetStart = "2025-08-28T00:00:00.000Z"; // ~9mo before 2026-05-28
  const targetEnd = `${TODAY}T23:59:59.999Z`;

  /** Priority A — recent gap (today backward to day after bulk end). */
  const priorityA: Batch[] = [
    {
      batch_id: "R1",
      priority_tier: "A_recent",
      sort_order: 1,
      action: "fetch_and_sync",
      window_start: "2026-05-01T00:00:00.000Z",
      window_end: `${TODAY}T23:59:59.999Z`,
      fetch_prompt: "REMOVAL-BACKFILL-RECENT-FETCH-MAY2026",
      sync_prompt: "REMOVAL-BACKFILL-RECENT-DOMAIN-SYNC-MAY2026",
      api_report_creates: 2,
      notes: "Most recent month through today — highest operational value",
    },
    {
      batch_id: "R2",
      priority_tier: "A_recent",
      sort_order: 2,
      action: "fetch_and_sync",
      window_start: "2026-04-22T00:00:00.000Z",
      window_end: "2026-04-30T23:59:59.999Z",
      fetch_prompt: "REMOVAL-BACKFILL-RECENT-FETCH-APR2026-TAIL",
      sync_prompt: "REMOVAL-BACKFILL-RECENT-DOMAIN-SYNC-APR2026-TAIL",
      api_report_creates: 2,
      notes: "Bridges bulk end 2026-04-21 → May 2026",
    },
  ];

  /** Priority B — historical gap (Dec 25 backward to Sep 1), newest-first within tier. */
  const priorityB: Batch[] = [
    {
      batch_id: "H1",
      priority_tier: "B_historical",
      sort_order: 3,
      action: "fetch_and_sync",
      window_start: "2025-12-01T00:00:00.000Z",
      window_end: "2025-12-25T23:59:59.999Z",
      fetch_prompt: "REMOVAL-BACKFILL-HIST-FETCH-DEC2025-PARTIAL",
      sync_prompt: "REMOVAL-BACKFILL-HIST-DOMAIN-SYNC-DEC2025-PARTIAL",
      api_report_creates: 2,
      notes: "Dec 1–25 before bulk starts 2025-12-26",
    },
    {
      batch_id: "H2",
      priority_tier: "B_historical",
      sort_order: 4,
      action: "fetch_and_sync",
      window_start: "2025-11-01T00:00:00.000Z",
      window_end: "2025-11-30T23:59:59.999Z",
      fetch_prompt: "REMOVAL-BACKFILL-HIST-FETCH-NOV2025",
      sync_prompt: "REMOVAL-BACKFILL-HIST-DOMAIN-SYNC-NOV2025",
      api_report_creates: 2,
    },
    {
      batch_id: "H3",
      priority_tier: "B_historical",
      sort_order: 5,
      action: "fetch_and_sync",
      window_start: "2025-10-01T00:00:00.000Z",
      window_end: "2025-10-31T23:59:59.999Z",
      fetch_prompt: "REMOVAL-BACKFILL-HIST-FETCH-OCT2025",
      sync_prompt: "REMOVAL-BACKFILL-HIST-DOMAIN-SYNC-OCT2025",
      api_report_creates: 2,
    },
    {
      batch_id: "H4",
      priority_tier: "B_historical",
      sort_order: 6,
      action: "domain_sync_only",
      window_start: "2025-09-01T00:00:00.000Z",
      window_end: "2025-09-30T23:59:59.999Z",
      fetch_prompt: null,
      sync_prompt: "REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC-CHUNK2",
      order_upload_id: FETCHED_ONLY[0]!.order_upload_id,
      shipment_upload_id: FETCHED_ONLY[0]!.shipment_upload_id,
      api_report_creates: 0,
      notes: "Chunk2 already fetched (356 order / 2721 shipment rows); sync held until Priority A complete",
    },
  ];

  const executionQueue = [...priorityA, ...priorityB];
  const nextRecent = priorityA[0]!;
  const chunk2Decision = {
    recommendation: "HOLD domain sync until Priority A (R1+R2) fetch+sync complete",
    rationale: [
      "Operational readiness requires recent removals in domain/expected_packages first.",
      "Chunk2 raw uploads are preserved (fetch PASS 20260528T000000Z); sync is idempotent when run.",
      "Syncing Sep 2025 before May 2026 would grow EP/resolver work on stale window while scanner ops still lack Apr–May 2026 coverage.",
    ],
    when_to_run: "Immediately after R2 domain sync PASS, as batch H4 (before H1 Oct–Dec fetches).",
  };

  const remainingFetchBatches = executionQueue.filter((b) => b.action === "fetch_and_sync");
  const totalApiCreates = remainingFetchBatches.reduce((s, b) => s + b.api_report_creates, 0);

  fs.writeFileSync(
    path.join(outDir, "coverage-inventory.json"),
    JSON.stringify(
      {
        today_utc: TODAY,
        target_window: { start: targetStart, end: targetEnd },
        covered_synced: COVERED_SYNCED,
        fetched_only: FETCHED_ONLY,
        gaps_remaining: {
          recent: "2026-04-22 → 2026-05-28",
          historical: "2025-09-01 → 2025-12-25 (Sep fetch-only; Oct–Dec fetch pending)",
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "priority-order.md"),
    [
      "# Priority order (today → backward)",
      "",
      "## Tier A — Recent (do first)",
      "",
      "| Batch | Window | Action |",
      "|-------|--------|--------|",
      ...priorityA.map(
        (b) =>
          `| **${b.batch_id}** | ${b.window_start.slice(0, 10)} → ${b.window_end.slice(0, 10)} | fetch + domain sync + rebuild + resolver |`,
      ),
      "",
      "## Tier B — Historical (after Tier A)",
      "",
      "| Batch | Window | Action |",
      "|-------|--------|--------|",
      ...priorityB.map((b) =>
        b.action === "domain_sync_only"
          ? `| **${b.batch_id}** | ${b.window_start.slice(0, 10)} → ${b.window_end.slice(0, 10)} | **domain sync only** (chunk2 fetched) |`
          : `| **${b.batch_id}** | ${b.window_start.slice(0, 10)} → ${b.window_end.slice(0, 10)} | fetch + domain sync + rebuild + resolver |`,
      ),
      "",
      "## Preserved (do not re-fetch)",
      "",
      ...COVERED_SYNCED.map(
        (c) => `- **${c.label}**: ${c.start.slice(0, 10)} → ${c.end.slice(0, 10)} (${c.status})`,
      ),
      `- **chunk1**: ${COVERED_SYNCED[1]!.start.slice(0, 10)} → ${COVERED_SYNCED[1]!.end.slice(0, 10)}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "chunk2-sync-decision.md"),
    [
      "# Chunk2 (Sep 2025) — sync now or hold?",
      "",
      `**Decision:** ${chunk2Decision.recommendation}`,
      "",
      "## Rationale",
      "",
      ...chunk2Decision.rationale.map((r) => `- ${r}`),
      "",
      "## When to run",
      "",
      chunk2Decision.when_to_run,
      "",
      "## Upload IDs (when approved)",
      "",
      `- ORDER: \`${FETCHED_ONLY[0]!.order_upload_id}\` (${FETCHED_ONLY[0]!.order_rows} rows)`,
      `- SHIPMENT: \`${FETCHED_ONLY[0]!.shipment_upload_id}\` (${FETCHED_ONLY[0]!.shipment_rows} rows)`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "execution-queue.json"),
    JSON.stringify(
      {
        reorder_policy: "today_backward_within_tier",
        total_batches: executionQueue.length,
        fetch_batches_remaining: remainingFetchBatches.length,
        domain_sync_only_batches: 1,
        estimated_api_report_creates: totalApiCreates,
        max_per_session: 2,
        estimated_sessions: Math.ceil(remainingFetchBatches.length / 2),
        queue: executionQueue,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "execute-prompts.md"),
    [
      "# Executable prompts (approval-gated)",
      "",
      "## Approvals",
      "",
      "- Fetch: `.cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md`",
      "- Domain sync: `.cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md`",
      "- Resolver: `.cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md`",
      "",
      "---",
      "",
      "## NEXT — Tier A batch R1 (May 2026 → today)",
      "",
      "```text",
      "# REMOVAL-BACKFILL-RECENT-FETCH-MAY2026",
      "",
      "Owner: Main/user",
      "Branch: feature/product-canonicalization-v2",
      "Mode: Agent, approval-gated staging writes only",
      "",
      "Window: 2026-05-01T00:00:00.000Z → 2026-05-28T23:59:59.999Z",
      "Reports: REMOVAL_ORDER + REMOVAL_SHIPMENT",
      "",
      "Approval: removal-9-month-backfill-fetch-approval.md",
      "  APPROVED_TO_RUN_STAGING=true",
      "  APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=true",
      "",
      "Execute:",
      "  npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --apply \\",
      "    --window-start=2026-05-01T00:00:00.000Z \\",
      "    --window-end=2026-05-28T23:59:59.999Z",
      "",
      "Then:",
      "# REMOVAL-BACKFILL-RECENT-DOMAIN-SYNC-MAY2026",
      "  npx tsx scripts/sp-api-removal-reports-domain-sync-execute.ts --apply \\",
      "    --order-upload-id=<from fetch manifest> \\",
      "    --shipment-upload-id=<from fetch manifest>",
      "```",
      "",
      "---",
      "",
      "## Tier A batch R2 (Apr 22–30 tail)",
      "",
      "```text",
      "# REMOVAL-BACKFILL-RECENT-FETCH-APR2026-TAIL",
      "Window: 2026-04-22T00:00:00.000Z → 2026-04-30T23:59:59.999Z",
      "Same fetch approval + domain sync approval as R1",
      "```",
      "",
      "---",
      "",
      "## Tier B — after R1+R2 PASS",
      "",
      "```text",
      "# REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC-CHUNK2  (H4 — no fetch)",
      "Order: 06ddd21c-6eee-4e44-907e-c2586ebdde51",
      "Shipment: 3e682300-5ba3-481b-9895-69607069d933",
      "  npx tsx scripts/removal-9-month-backfill-domain-sync-chunk2-execute.ts --apply",
      "  (or sp-api-removal-reports-domain-sync-execute.ts with upload IDs)",
      "",
      "# REMOVAL-BACKFILL-HIST-FETCH-DEC2025-PARTIAL → … → OCT2025",
      "See execution-queue.json batches H1–H3",
      "```",
      "",
      "---",
      "",
      "## Full queue",
      "",
      ...executionQueue.map(
        (b) =>
          `${b.sort_order}. **${b.batch_id}** ${b.fetch_prompt ?? b.sync_prompt} — ${b.window_start.slice(0, 10)}..${b.window_end.slice(0, 10)}`,
      ),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None (read-only plan)\n",
  );

  const exactNextPrompt = `# REMOVAL-BACKFILL-RECENT-FETCH-MAY2026

Owner: Main/user
Branch: feature/product-canonicalization-v2
Mode: Agent, approval-gated staging writes only

## Purpose
Fetch SP-API REMOVAL_ORDER + REMOVAL_SHIPMENT for the highest-priority recent gap (May 2026 through today).

## Window
2026-05-01T00:00:00.000Z → 2026-05-28T23:59:59.999Z

## Approval
.cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=true

## Execute
npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --apply \\
  --window-start=2026-05-01T00:00:00.000Z \\
  --window-end=2026-05-28T23:59:59.999Z

## Then
REMOVAL-BACKFILL-RECENT-DOMAIN-SYNC-MAY2026 (domain sync + rebuild + resolver)`;

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        ok: blockers.length === 0,
        mode: "read-only-plan",
        today: TODAY,
        next_recent_window: {
          batch_id: nextRecent.batch_id,
          start: nextRecent.window_start,
          end: nextRecent.window_end,
          prompt: nextRecent.fetch_prompt,
        },
        old_chunks_remaining: {
          fetch_and_sync: remainingFetchBatches.length,
          domain_sync_only: 1,
          batches: executionQueue.filter((b) => b.sort_order > 2).map((b) => b.batch_id),
        },
        chunk2_decision: chunk2Decision.recommendation,
        estimated_api_creates_remaining: totalApiCreates,
        exact_next_prompt: "REMOVAL-BACKFILL-RECENT-FETCH-MAY2026",
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(outDir, "exact-next-prompt.md"), exactNextPrompt + "\n");

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir,
        next_recent_window: `${nextRecent.window_start.slice(0, 10)}..${nextRecent.window_end.slice(0, 10)}`,
        old_chunks_remaining: remainingFetchBatches.length,
        chunk2: chunk2Decision.recommendation,
        exact_next_prompt: "REMOVAL-BACKFILL-RECENT-FETCH-MAY2026",
      },
      null,
      2,
    ),
  );
}

main();
