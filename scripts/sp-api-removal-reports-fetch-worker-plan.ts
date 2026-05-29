/**
 * SP-API REMOVAL REPORTS FETCH WORKER PLAN (read-only)
 *
 * Plans Reports API workers for removal order + shipment detail reports.
 * No Amazon HTTP. No DB writes.
 *
 *   npx tsx scripts/sp-api-removal-reports-fetch-worker-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-reports-fetch-worker-plan";
const APPROVAL_FETCH = ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md";
const APPROVAL_IMPORT = ".cursor/operator-approvals/removal-shipment-normalized-import-staging-approval.md";

const SP_API_REPORT_ORDER = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
const SP_API_REPORT_SHIPMENT = "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA";

const REUSE_ANCHORS = [
  "lib/amazon/reports-api-pull-worker.ts",
  "lib/amazon/reports-api-reimbursements-worker.ts",
  "lib/amazon/reports-api-worker-profile.ts",
  "lib/amazon/reports-api-synthetic-upload.ts",
  "lib/amazon/reports-api-pipeline-handoff.ts",
  "lib/amazon/reports-api-source-run.ts",
  "lib/amazon/reports-api-worker-flags.ts",
  "lib/amazon/amazon-report-type-crosswalk.ts",
  "lib/pipeline/amazon-report-registry.ts",
  "app/api/settings/imports/reports-api/run/route.ts",
  "app/api/settings/imports/reports-api/resume/route.ts",
] as const;

const FILES_TO_CREATE = [
  "lib/amazon/reports-api-removal-order-worker.ts",
  "lib/amazon/reports-api-removal-shipment-worker.ts",
  "app/api/settings/imports/reports-api/removal-order/run/route.ts",
  "app/api/settings/imports/reports-api/removal-order/resume/route.ts",
  "app/api/settings/imports/reports-api/removal-shipment/run/route.ts",
  "app/api/settings/imports/reports-api/removal-shipment/resume/route.ts",
  "scripts/sp-api-removal-reports-fetch-execute.ts",
  "tests/fixtures/sp-api-reports/removal-order/",
  "tests/fixtures/sp-api-reports/removal-shipment/",
] as const;

const FILES_TO_CHANGE = [
  "lib/amazon/reports-api-worker-profile.ts",
  "lib/amazon/reports-api-source-run.ts",
  "lib/amazon/reports-api-synthetic-upload.ts",
  "lib/amazon/reports-api-worker-flags.ts",
  "lib/import/import-upload-descriptor-metadata.ts (new descriptor ids)",
  "tests/fixtures/import-upload-descriptor-metadata/removal-order.json",
  "tests/fixtures/import-upload-descriptor-metadata/removal-shipment.json",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

function readApprovalFlags(relPath: string): { staging: boolean; scope: boolean } {
  const p = path.join(process.cwd(), relPath);
  if (!fs.existsSync(p)) {
    return { staging: false, scope: false };
  }
  const text = fs.readFileSync(p, "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const scope = /APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH\s*=\s*true/i.test(text);
  return { staging, scope };
}

function ensureApprovalFile(): void {
  if (fileExists(APPROVAL_FETCH)) return;
  fs.mkdirSync(path.dirname(path.join(process.cwd(), APPROVAL_FETCH)), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_FETCH),
    `# SP-API removal shipment fetch

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product create from title only | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=false
\`\`\`

## Scope

- Reports API fetch for:
  - \`GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA\`
  - \`GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA\`
- Download → synthetic \`raw_report_uploads\` (no direct domain write in fetch phase)

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

function main(): void {
  loadEnvLocalIntoProcess();
  ensureApprovalFile();

  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch is \`${branch}\`; expected \`${REQUIRED_BRANCH}\`.`);
  }
  if (!supabaseUrlMatchesStagingRef(STAGING_REF)) {
    blockers.push(
      `SUPABASE_URL does not match staging ref \`${STAGING_REF}\` (plan-only; execute must target staging).`,
    );
  }

  const approval = readApprovalFlags(APPROVAL_FETCH);

  const missingReuse = REUSE_ANCHORS.filter((f) => !fileExists(f));
  if (missingReuse.length) {
    blockers.push(`Missing expected reuse anchors: ${missingReuse.join(", ")}`);
  }

  const hasRemovalWorker =
    fileExists("lib/amazon/reports-api-removal-order-worker.ts") ||
    fileExists("lib/amazon/reports-api-removal-shipment-worker.ts");
  if (hasRemovalWorker) {
    blockers.push("Removal Reports API worker file(s) already exist — reconcile before re-implementing.");
  }

  fs.writeFileSync(
    path.join(outDir, "fetch-worker-architecture.md"),
    [
      "# Fetch worker architecture",
      "",
      "## Goal",
      "",
      "Add SP-API Reports pull workers for FBA removal reports that **only** fetch, archive, and register synthetic `raw_report_uploads`. Domain tables (`amazon_removals`, `amazon_removal_shipments`, `expected_packages`) are populated later via existing Phase 2–4 import pipeline under separate operator approval.",
      "",
      "## Pattern (reuse reimbursements)",
      "",
      "```",
      "POST run route",
      "  → runRemoval*ReportsWorker(req, { runPipeline: false })",
      "  → runReportsApiPullWorker(req, { profile: REMOVAL_*_PULL_PROFILE })",
      "       resolveReportsApiContext(org, store)",
      "       idempotency lookup / placeholder upload",
      "       createReport (on_demand) → poll getReport → getReportDocument → download",
      "       writeSyntheticReportBytes → finalizeSyntheticUploadForPipeline",
      "       state = synthetic_upload_ready (stop; needs_resume=true when runPipeline=false)",
      "POST resume route",
      "  → same worker with upload_id + window from metadata.source_run",
      "```",
      "",
      "## Two profiles (one worker entry each)",
      "",
      "| Profile | SP report type | `uploadReportType` | Sync kind | Domain table |",
      "|---------|----------------|-------------------|-----------|--------------|",
      `| \`REMOVAL_ORDER_PULL_PROFILE\` | \`${SP_API_REPORT_ORDER}\` | \`REMOVAL_ORDER\` | \`REMOVAL_ORDER\` | \`amazon_removals\` |`,
      `| \`REMOVAL_SHIPMENT_PULL_PROFILE\` | \`${SP_API_REPORT_SHIPMENT}\` | \`REMOVAL_SHIPMENT\` | \`REMOVAL_SHIPMENT\` | \`amazon_removal_shipments\` |`,
      "",
      "Both use `acquisitionMode: on_demand_create` and `client.createReport` (same as reimbursements — not settlement list mode).",
      "",
      "## Orchestration order (execute script)",
      "",
      "1. **Order detail first** — populates `amazon_removals` after normalized import.",
      "2. **Shipment detail second** — populates `amazon_removal_shipments`; Phase 4 generic rebuilds `expected_packages` from removals.",
      "",
      "Fetch execute may run both in one operator session but must use **separate uploads** and idempotency keys per report type.",
      "",
      "## Pipeline handoff (deferred on fetch)",
      "",
      "- `runReportsApiImportPipeline` in `lib/amazon/reports-api-pipeline-handoff.ts` already supports any upload whose `report_type` resolves via `resolveAmazonImportSyncKind`.",
      "- `REMOVAL_ORDER`: Phase 3 sync only (`supports_generic: false`).",
      "- `REMOVAL_SHIPMENT`: Phase 3 + Phase 4 `removal_shipment_tree` → `expected_packages` (`supports_generic: true`).",
      "- **Fetch approval:** pass `runPipeline: false` so worker stops at `synthetic_upload_ready`.",
      "- **Import approval:** separate resume/run with `runPipeline: true` or manual process/sync/generic routes.",
      "",
      "## Reuse anchors (existing)",
      "",
      ...REUSE_ANCHORS.map((f) => `- \`${f}\``),
      "",
      "## Files to add",
      "",
      ...FILES_TO_CREATE.map((f) => `- \`${f}\``),
      "",
      "## Files to extend",
      "",
      ...FILES_TO_CHANGE.map((f) => `- \`${f}\``),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "report-types-and-date-windows.md"),
    [
      "# Report types and date windows",
      "",
      "## Report types",
      "",
      "| Amazon `reportType` | Canonical upload `report_type` | Registry kind |",
      "|---------------------|----------------------------------|---------------|",
      `| \`${SP_API_REPORT_ORDER}\` | \`REMOVAL_ORDER\` | \`REMOVAL_ORDER\` |`,
      `| \`${SP_API_REPORT_SHIPMENT}\` | \`REMOVAL_SHIPMENT\` | \`REMOVAL_SHIPMENT\` |`,
      "",
      "Crosswalk: `lib/amazon/amazon-report-type-crosswalk.ts` (already maps both types).",
      "",
      "## Date window contract",
      "",
      "- API body fields: `window_start`, `window_end` (ISO-8601 UTC strings).",
      "- Mapped to SP-API `dataStartTime` / `dataEndTime` via `buildOnDemandCreateReportBody` (`lib/amazon/reports-api-report-request.ts`).",
      "- Stored on `metadata.source_run.window` for resume and idempotency.",
      "",
      "## Window planning rules",
      "",
      "| Rule | Recommendation |",
      "|------|----------------|",
      "| Granularity | **Monthly or weekly** slices for backfill; avoid multi-year single requests |",
      "| Overlap | Allow **0–1 day overlap** between adjacent windows only when reconciling boundary rows; idempotency key prevents duplicate uploads for identical window |",
      "| Future end | `window_end` must be ≤ now (Amazon rejects far-future ranges) |",
      "| Minimum span | At least 1 hour; prefer full calendar days aligned to UTC midnight |",
      "| Backfill | Iterate windows oldest→newest; **order report before shipment** for each window |",
      "| Marketplace | Use `resolveReportsApiContext` marketplace list (store credential + retail filter) |",
      "",
      "## Execute defaults (staging)",
      "",
      "- Operator supplies explicit `window_start` / `window_end` per run (no hidden auto-window in v1).",
      "- Optional follow-up: CLI flag `--months=N` that expands to N monthly windows (plan only; not implemented).",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "synthetic-upload-contract.md"),
    [
      "# Synthetic upload contract",
      "",
      "## Placeholder upload (`createReportsApiPlaceholderUpload`)",
      "",
      "| Field | Value |",
      "|-------|--------|",
      "| `report_type` | `REMOVAL_ORDER` or `REMOVAL_SHIPMENT` |",
      "| `metadata.source_run` | Full `SourceRunV1` control plane |",
      "| `metadata.source` | `amazon_reports_api` |",
      "| `metadata.import_store_id` / `ledger_store_id` | Request `store_id` |",
      "| `file_name` | `spapi://reports/<SP_TYPE>/<reportDocumentId>.tsv` |",
      "| `file_extension` | `tsv` |",
      "| Import descriptor | **New** `amazon.removal_order.file.v1` / `amazon.removal_shipment.file.v1` (fixtures required; reimbursements uses `amazon.reimbursements.file.v1`) |",
      "",
      "## After download",
      "",
      "1. `writeSyntheticReportBytes` → `raw-reports` bucket under `storage_prefix`.",
      "2. `metadata.content_sha256`, `archive` on `source_run` (sha256, byte_length, object_key).",
      "3. `finalizeSyntheticUploadForPipeline`: headers from TSV first line, status ready for Phase 2.",
      "4. Terminal fetch state: **`synthetic_upload_ready`** when `runPipeline: false`.",
      "",
      "## Content type",
      "",
      "- Amazon removal reports are tab-delimited (`text/tab-separated-values`).",
      "- Use same decompress path as reimbursements (`decompressReportDocument`).",
      "",
      "## What fetch must NOT do",
      "",
      "- No insert/update on `amazon_removals`, `amazon_removal_shipments`, `expected_packages`, `products`.",
      "- No `runReportsApiImportPipeline` during fetch-approved execute (`runPipeline: false`).",
      "- No product resolution or identifier map writes.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "idempotency-and-retry-rules.md"),
    [
      "# Idempotency and retry rules",
      "",
      "## Idempotency key",
      "",
      "Reuse `buildReportsApiIdempotencyKey` with:",
      "",
      "- `reportType` = SP-API type string (`GET_FBA_FULFILLMENT_REMOVAL_*`)",
      "- `operation` = profile `sourceRunOperation` (default `reports.create_and_download` or removal-specific suffix)",
      "- `organizationId`, `storeId`, `windowStart`, `windowEnd`, sorted `marketplaceIds`",
      "",
      "Add helpers:",
      "",
      "- `buildRemovalOrderIdempotencyKey(...)`",
      "- `buildRemovalShipmentIdempotencyKey(...)`",
      "",
      "## Layers",
      "",
      "| Layer | Key | Behavior |",
      "|-------|-----|----------|",
      "| SP-API `report_id` | `source_run.external_ids.report_id` | Re-poll same report on resume; do not createReport again if id present and not failed |",
      "| Upload row | `(organization_id, report_type, metadata.source_run.idempotency_key)` | `findUploadBySourceRunIdempotencyKey` — **extend** `uploadReportType` union to include `REMOVAL_ORDER` \\| `REMOVAL_SHIPMENT` |",
      "| Content | `metadata.content_sha256` | Same bytes → existing sync dedupe (`removal_shipment_replace_same_file_sha` on shipment sync) |",
      "| Domain | Registry conflict columns | Phase 3 upsert — unchanged |",
      "",
      "## Replay rules",
      "",
      "- If prior upload `source_run.state === complete` and pipeline completion says no work → HTTP 200 `idempotent_replay: true`.",
      "- If prior state non-terminal → resume same `upload_id`.",
      "- If `failed` with retriable code and `attempt.count < REPORTS_API_MAX_ATTEMPTS` → resume with backoff (`scheduleRetryIso`).",
      "- Auth failure or max attempts → terminal `failed`, operator must fix credentials or window.",
      "",
      "## Duplicate prevention",
      "",
      "- **Never** call `createReport` when `external_ids.report_id` is set and poll/download not complete.",
      "- **Never** create second placeholder upload for same idempotency key while non-terminal row exists.",
      "- Order and shipment reports are **different** `report_type` values → separate idempotency namespaces.",
      "",
      "## Throttling",
      "",
      "- `isReportsApiThrottleError` → increment attempt, set `next_retry_at`, return `needs_resume: true` (HTTP 202).",
      "- Respect `REPORTS_API_REQUEST_BUDGET_MS` (25s) per invocation — resume route continues poll/download.",
      "- Max attempts: `REPORTS_API_MAX_ATTEMPTS` (3) per upload.",
    ].join("\n") + "\n",
  );

  const envChecks = [
    ["ENABLE_AMAZON_REPORTS_API_WORKER", "Master switch (required)"],
    ["ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER", "Planned sub-flag for order detail"],
    ["ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT", "Planned sub-flag for shipment detail"],
    ["AWS_ACCESS_KEY_ID / secret (or store creds)", "SigV4 for Reports download URL"],
    ["SUPABASE_URL / SERVICE_ROLE", "Synthetic upload + metadata only on execute"],
  ];

  fs.writeFileSync(
    path.join(outDir, "env-and-credential-check.md"),
    [
      "# Env and credential check",
      "",
      "## Planned feature flags (`reports-api-worker-flags.ts`)",
      "",
      "| Env | Purpose |",
      "|-----|---------|",
      ...envChecks.map(([k, v]) => `| \`${k}\` | ${v} |`),
      "",
      "Add `reportsApiDisabledReasonForRemovalOrder()` / `...RemovalShipment()` mirroring reimbursements.",
      "",
      "## Runtime credential resolution",
      "",
      "- `resolveReportsApiContext(organizationId, storeId)` from `lib/amazon/reports-api-credentials.ts`.",
      "- Requires complete LWA + refresh token on store/marketplace credentials.",
      "- AWS keys for signed download (env or credential blob).",
      "- Marketplace IDs validated via `filterValidAmazonRetailMarketplaceIds`.",
      "",
      "## Execute preflight (staging)",
      "",
      "1. `APPROVED_TO_RUN_STAGING=true` and `APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=true` in approval file.",
      "2. `supabaseUrlMatchesStagingRef(eiqfaapyumhixxoeltgu)`.",
      "3. Master + removal sub-flags enabled in environment.",
      "4. Store UUID + org UUID known; window bounds validated.",
      "5. **No** `NEXT_PUBLIC_*` flags for Reports API (server-only).",
      "",
      "## Plan run (this script)",
      "",
      "- Does not call Amazon.",
      "- Does not read or print secrets.",
      "- May warn if Supabase URL is not staging (local dev safety).",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      "| Path | Flags |",
      "|------|-------|",
      `| \`${APPROVAL_FETCH}\` | \`APPROVED_TO_RUN_STAGING\`, \`APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH\` |`,
      `| \`${APPROVAL_IMPORT}\` | Normalized import + rebuild (separate from fetch) |`,
      "",
      "## Fetch scope (this plan)",
      "",
      "- Covers **both** removal report types under one fetch approval flag.",
      "- Execute script must refuse if either flag is false.",
      "",
      "## Current sign-off state",
      "",
      `- APPROVED_TO_RUN_STAGING: **${approval.staging}**`,
      `- APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH: **${approval.scope}**`,
      "",
      "## Default (unchanged)",
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=false",
      "```",
    ].join("\n") + "\n",
  );

  const planBlockers = [
    "No removal Reports API worker implemented (reimbursements/settlement only).",
    "`findUploadBySourceRunIdempotencyKey` / `createReportsApiPlaceholderUpload` typed for REIMBURSEMENTS | SETTLEMENT only.",
    "No `ENABLE_AMAZON_REPORTS_API_REMOVAL_*` sub-flags.",
    "No import descriptor fixtures for removal TSV (`amazon.removal_*.file.v1`).",
    "No mock tests under `tests/fixtures/sp-api-reports/removal-*`.",
    `Operator fetch approval not signed (${APPROVAL_FETCH}: APPROVED_* remain false until execute).`,
  ];

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [...blockers.map((b) => `- ${b}`), ...planBlockers.map((b) => `- ${b}`)].join("\n") + "\n",
  );

  const nextPrompt =
    "SP-API-REMOVAL-REPORTS-FETCH-EXECUTE — implement removal Reports API workers + run staging fetch (order then shipment) with runPipeline:false after APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=true";

  const manifest = {
    prompt: "SP-API REMOVAL REPORTS FETCH WORKER PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    report_types: {
      removal_order: SP_API_REPORT_ORDER,
      removal_shipment: SP_API_REPORT_SHIPMENT,
    },
    upload_report_types: ["REMOVAL_ORDER", "REMOVAL_SHIPMENT"],
    approval_file: APPROVAL_FETCH,
    approval_flags: approval,
    reuse_anchors: REUSE_ANCHORS,
    files_to_create: FILES_TO_CREATE,
    files_to_change: FILES_TO_CHANGE,
    exact_next_prompt: nextPrompt,
    forbidden: { amazon_api_called: false, db_writes: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        approval_file: APPROVAL_FETCH,
        blockers: blockers.length + planBlockers.length,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main();
