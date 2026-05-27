/**
 * REMOVAL NORMALIZED IMPORT PLAN AFTER FETCH (read-only)
 *
 *   npx tsx scripts/removal-normalized-import-plan-after-fetch.ts --run-id=<UTC_Z>
 *   npx tsx scripts/removal-normalized-import-plan-after-fetch.ts --fetch-run-id=20260527T091000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire, type Module } from "node:module";
import pg from "pg";

import { getAmazonDescriptorById } from "../lib/import/amazon-import-descriptors-v1";
import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const FETCH_BASE = ".cursor/audit-reports/sp-api-removal-reports-fetch-execute";
const OUT_BASE = ".cursor/audit-reports/removal-normalized-import-plan-after-fetch";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-shipment-normalized-import-staging-approval.md";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type UploadRow = {
  id: string;
  report_type: string;
  status: string;
  file_name: string | null;
  created_at: string;
  source_run_state: string | null;
  content_sha256: string | null;
  import_descriptor_id: string | null;
  csv_headers: string[] | null;
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

function fetchRunIdArg(): string | null {
  const a = process.argv.find((x) => x.startsWith("--fetch-run-id="));
  return a ? a.split("=")[1]!.trim() : null;
}

function latestFetchRunId(): string {
  const base = path.join(process.cwd(), FETCH_BASE);
  if (!fs.existsSync(base)) return "unknown";
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  return dirs[0] ?? "unknown";
}

function writeApproval(): void {
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_PATH),
    `# Removal shipment normalized import (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product create from title only | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=false
\`\`\`

## Scope

- Phase 2 staging → Phase 3 sync for \`REMOVAL_ORDER\` and \`REMOVAL_SHIPMENT\` synthetic uploads
- Phase 4 generic (\`removal_shipment_tree\`) for shipment upload only
- \`rebuild_expected_packages_from_removals(org, store)\` after both domain tables updated
- No \`products.insert\` / no title-only promotion in import phase

## Preconditions

- Fetch execute produced \`synthetic_upload_ready\` uploads for **both** report types, OR operator designates alternate ready upload IDs in execute prompt.

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

function isUploadReady(u: UploadRow): boolean {
  const sha = u.content_sha256?.trim();
  const state = u.source_run_state?.trim();
  return (
    !!sha &&
    (state === "synthetic_upload_ready" ||
      state === "complete" ||
      u.status === "mapped" ||
      u.status === "complete")
  );
}

async function loadUploadFromDb(client: pg.Client, uploadId: string): Promise<UploadRow | null> {
  const r = await client.query(
    `SELECT id::text, report_type, status, file_name, created_at::text, metadata
     FROM public.raw_report_uploads
     WHERE id = $1::uuid AND organization_id = $2::uuid`,
    [uploadId, ORG_ID],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const meta = row.metadata as Record<string, unknown> | null;
  const sr =
    meta?.source_run && typeof meta.source_run === "object"
      ? (meta.source_run as Record<string, unknown>)
      : null;
  const desc =
    meta?.import_descriptor && typeof meta.import_descriptor === "object"
      ? (meta.import_descriptor as Record<string, unknown>)
      : null;
  const headers = Array.isArray(meta?.csv_headers)
    ? meta.csv_headers.filter((h): h is string => typeof h === "string")
    : null;
  return {
    id: String(row.id),
    report_type: String(row.report_type ?? ""),
    status: String(row.status ?? ""),
    file_name: row.file_name != null ? String(row.file_name) : null,
    created_at: String(row.created_at ?? ""),
    source_run_state: sr?.state != null ? String(sr.state) : null,
    content_sha256: typeof meta?.content_sha256 === "string" ? meta.content_sha256 : null,
    import_descriptor_id:
      typeof desc?.descriptor_id === "string" ? desc.descriptor_id : null,
    csv_headers: headers,
  };
}

async function listReadyRemovalUploads(client: pg.Client): Promise<UploadRow[]> {
  const r = await client.query(
    `SELECT id::text, report_type, status, file_name, created_at::text, metadata
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
     ORDER BY created_at DESC
     LIMIT 80`,
    [ORG_ID],
  );
  const out: UploadRow[] = [];
  for (const row of r.rows as Record<string, unknown>[]) {
    const meta = row.metadata as Record<string, unknown> | null;
    const sr =
      meta?.source_run && typeof meta.source_run === "object"
        ? (meta.source_run as Record<string, unknown>)
        : null;
    const desc =
      meta?.import_descriptor && typeof meta.import_descriptor === "object"
        ? (meta.import_descriptor as Record<string, unknown>)
        : null;
    const headers = Array.isArray(meta?.csv_headers)
      ? meta.csv_headers.filter((h): h is string => typeof h === "string")
      : null;
    const u: UploadRow = {
      id: String(row.id),
      report_type: String(row.report_type ?? ""),
      status: String(row.status ?? ""),
      file_name: row.file_name != null ? String(row.file_name) : null,
      created_at: String(row.created_at ?? ""),
      source_run_state: sr?.state != null ? String(sr.state) : null,
      content_sha256: typeof meta?.content_sha256 === "string" ? meta.content_sha256 : null,
      import_descriptor_id:
        typeof desc?.descriptor_id === "string" ? desc.descriptor_id : null,
      csv_headers: headers,
    };
    if (isUploadReady(u)) out.push(u);
  }
  return out;
}

async function previewCounts(
  client: pg.Client,
  uploadId: string,
  reportType: string,
): Promise<{ staging: number; domain: number }> {
  const staging = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.amazon_staging WHERE upload_id = $1::uuid`,
    [uploadId],
  );
  const domainTable =
    reportType === "REMOVAL_ORDER" ? "amazon_removals" : "amazon_removal_shipments";
  const domain = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.${domainTable} WHERE upload_id = $1::uuid`,
    [uploadId],
  );
  return {
    staging: (staging.rows[0] as { c: number }).c,
    domain: (domain.rows[0] as { c: number }).c,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  writeApproval();

  const runId = runIdArg();
  const fetchRunId = fetchRunIdArg() ?? latestFetchRunId();
  const fetchDir = path.join(process.cwd(), FETCH_BASE, fetchRunId);
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
    blockers.push(`Branch \`${branch}\` !== \`${REQUIRED_BRANCH}\`.`);
  }

  let fetchManifest: Record<string, unknown> = {};
  let fetchSummary: Record<string, unknown> = {};
  if (fs.existsSync(path.join(fetchDir, "manifest.json"))) {
    fetchManifest = JSON.parse(
      fs.readFileSync(path.join(fetchDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
  } else {
    blockers.push(`Fetch execute manifest missing: ${FETCH_BASE}/${fetchRunId}/manifest.json`);
  }
  if (fs.existsSync(path.join(fetchDir, "synthetic-upload-summary.json"))) {
    fetchSummary = JSON.parse(
      fs.readFileSync(path.join(fetchDir, "synthetic-upload-summary.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  const fetchOrderOk = fetchManifest.order_report_fetched === true;
  const fetchShipmentOk = fetchManifest.shipment_report_fetched === true;
  const fetchSyntheticCount = Number(fetchSummary.count ?? 0);

  const failedPlaceholders =
    (fetchSummary.failed_placeholders as Array<Record<string, unknown>> | undefined) ?? [];

  const fetchUploadIds = failedPlaceholders.map((p) => String(p.upload_id ?? "")).filter(Boolean);

  let fetchUploadRows: UploadRow[] = [];
  let readyUploads: UploadRow[] = [];
  let orderPreview = { staging: 0, domain: 0, upload_id: null as string | null };
  let shipmentPreview = { staging: 0, domain: 0, upload_id: null as string | null };
  let baseline = { removals: 0, shipments: 0, ep_derived: 0 };

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '90s'");

    for (const id of fetchUploadIds) {
      const u = await loadUploadFromDb(client, id);
      if (u) fetchUploadRows.push(u);
    }
    readyUploads = await listReadyRemovalUploads(client);

    const base = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.amazon_removals) AS removals,
        (SELECT COUNT(*)::int FROM public.amazon_removal_shipments) AS shipments,
        (SELECT COUNT(*)::int FROM public.expected_packages
          WHERE build_source IN ('detail_shipment', 'detail_remainder')) AS ep_derived`);
    baseline = base.rows[0] as typeof baseline;

    const orderReady =
      readyUploads.find((u) => u.report_type === "REMOVAL_ORDER") ??
      fetchUploadRows.find((u) => u.report_type === "REMOVAL_ORDER");
    const shipReady =
      readyUploads.find((u) => u.report_type === "REMOVAL_SHIPMENT") ??
      fetchUploadRows.find((u) => u.report_type === "REMOVAL_SHIPMENT");

    if (orderReady) {
      orderPreview.upload_id = orderReady.id;
      const c = await previewCounts(client, orderReady.id, "REMOVAL_ORDER");
      orderPreview = { ...c, upload_id: orderReady.id };
    }
    if (shipReady) {
      shipmentPreview.upload_id = shipReady.id;
      const c = await previewCounts(client, shipReady.id, "REMOVAL_SHIPMENT");
      shipmentPreview = { ...c, upload_id: shipReady.id };
    }

    await client.end();
  } else {
    blockers.push("STAGING_DIRECT_POSTGRES_URL unset or not staging — DB inventory skipped.");
  }

  const orderReadyUpload = readyUploads.find((u) => u.report_type === "REMOVAL_ORDER");
  const shipmentReadyUpload = readyUploads.find((u) => u.report_type === "REMOVAL_SHIPMENT");
  const uploadsReady = !!(orderReadyUpload && shipmentReadyUpload);

  if (!fetchOrderOk || !fetchShipmentOk) {
    blockers.push(
      `Latest fetch execute (${fetchRunId}) did not reach synthetic_upload_ready for both reports (order=${fetchOrderOk}, shipment=${fetchShipmentOk}, ready_count=${fetchSyntheticCount}).`,
    );
  }
  if (!uploadsReady) {
    blockers.push(
      "No pair of staging-ready REMOVAL_ORDER + REMOVAL_SHIPMENT uploads found (content_sha256 + synthetic_upload_ready/mapped).",
    );
  }

  const descOrder = getAmazonDescriptorById("amazon.removal_order.file.v1");
  const descShipment = getAmazonDescriptorById("amazon.removal_shipment.file.v1");
  if (!descOrder || !descShipment) {
    blockers.push("Import descriptors missing for removal_order or removal_shipment.");
  }

  fs.writeFileSync(
    path.join(outDir, "fetch-precondition-check.md"),
    [
      "# Fetch precondition check",
      "",
      `| Item | Value |`,
      `|------|-------|`,
      `| Fetch run | \`${FETCH_BASE}/${fetchRunId}\` |`,
      `| Fetch status | \`${String(fetchManifest.status ?? "unknown")}\` |`,
      `| Order fetched (execute manifest) | **${fetchOrderOk}** |`,
      `| Shipment fetched (execute manifest) | **${fetchShipmentOk}** |`,
      `| synthetic_upload_ready count (fetch) | **${fetchSyntheticCount}** |`,
      `| Staging-ready pair in DB now | **${uploadsReady}** |`,
      "",
      "## Fetch placeholder uploads (failed)",
      "",
      ...(failedPlaceholders.length
        ? failedPlaceholders.map(
            (p) =>
              `- \`${p.label}\`: upload \`${p.upload_id}\` state=\`${p.final_state}\` code=\`${p.error_code}\` — **not importable**`,
          )
        : ["- (none in summary)"]),
      "",
      "## Gate",
      "",
      "Normalized import execute is **blocked** until both uploads have `content_sha256` and `source_run.state` ≥ `synthetic_upload_ready`.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "synthetic-upload-inventory.md"),
    [
      "# Synthetic upload inventory",
      "",
      "## From fetch execute",
      "",
      ...fetchUploadRows.map(
        (u) =>
          `- \`${u.id}\` **${u.report_type}** status=\`${u.status}\` source_run=\`${u.source_run_state ?? "—"}\` sha=\`${u.content_sha256 ? "yes" : "no"}\``,
      ),
      "",
      "## Staging-ready REMOVAL uploads (org-wide, latest)",
      "",
      ...(readyUploads.length
        ? readyUploads.map(
            (u) =>
              `- \`${u.id}\` **${u.report_type}** created=\`${u.created_at}\` descriptor=\`${u.import_descriptor_id ?? "—"}\``,
          )
        : ["- None"]),
      "",
      "## Selected for import plan",
      "",
      `| Kind | upload_id |`,
      `|------|-----------|`,
      `| REMOVAL_ORDER | \`${orderReadyUpload?.id ?? orderPreview.upload_id ?? "—"}\` |`,
      `| REMOVAL_SHIPMENT | \`${shipmentReadyUpload?.id ?? shipmentPreview.upload_id ?? "—"}\` |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "header-descriptor-validation.md"),
    [
      "# Header / descriptor validation",
      "",
      "## Registry descriptors (required)",
      "",
      "| descriptor_id | import_kind | status |",
      "|---------------|-------------|--------|",
      `| \`amazon.removal_order.file.v1\` | REMOVAL_ORDER | ${descOrder ? "live" : "MISSING"} |`,
      `| \`amazon.removal_shipment.file.v1\` | REMOVAL_SHIPMENT | ${descShipment ? "live" : "MISSING"} |`,
      "",
      "## Expected SP-API profile IDs (Reports worker)",
      "",
      "- `REMOVAL_ORDER_PULL_PROFILE.importDescriptorId` → `amazon.removal_order.file.v1`",
      "- `REMOVAL_SHIPMENT_PULL_PROFILE.importDescriptorId` → `amazon.removal_shipment.file.v1`",
      "",
      "## Fixture header hints (detector)",
      "",
      "**REMOVAL_ORDER** (`tests/fixtures/amazon-report-headers/removal_order.json`):",
      "`removal-order-id`, `sku`, `fnsku`, `requested-quantity`, `disposed-quantity`",
      "",
      "**REMOVAL_SHIPMENT** (`tests/fixtures/amazon-report-headers/removal_shipment.json`):",
      "`order-id`, `tracking-number`, `carrier`, `shipment-date`, `sku`",
      "",
      "## Upload metadata headers (when ready)",
      "",
      orderReadyUpload?.csv_headers?.length
        ? `Order upload headers (${orderReadyUpload.csv_headers.length}): ${orderReadyUpload.csv_headers.slice(0, 12).join(", ")}${orderReadyUpload.csv_headers.length > 12 ? "…" : ""}`
        : "Order upload: no csv_headers on metadata (not ready or legacy CSV).",
      "",
      shipmentReadyUpload?.csv_headers?.length
        ? `Shipment upload headers (${shipmentReadyUpload.csv_headers.length}): ${shipmentReadyUpload.csv_headers.slice(0, 12).join(", ")}${shipmentReadyUpload.csv_headers.length > 12 ? "…" : ""}`
        : "Shipment upload: no csv_headers on metadata (not ready or legacy CSV).",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "row-count-preview.md"),
    [
      "# Row count preview",
      "",
      "## Baseline (staging DB, all history)",
      "",
      `| Table | Rows |`,
      `|-------|------|`,
      `| \`amazon_removals\` | **${baseline.removals}** |`,
      `| \`amazon_removal_shipments\` | **${baseline.shipments}** |`,
      `| \`expected_packages\` (detail_shipment + detail_remainder) | **${baseline.ep_derived}** |`,
      "",
      "## Per-upload (if upload selected)",
      "",
      "| Report | upload_id | amazon_staging | domain table |",
      "|--------|-----------|----------------|--------------|",
      `| REMOVAL_ORDER | \`${orderPreview.upload_id ?? "—"}\` | ${orderPreview.staging} | ${orderPreview.domain} (\`amazon_removals\`) |`,
      `| REMOVAL_SHIPMENT | \`${shipmentPreview.upload_id ?? "—"}\` | ${shipmentPreview.staging} | ${shipmentPreview.domain} (\`amazon_removal_shipments\`) |`,
      "",
      "> Post-import execute: re-query these counts; expect domain rows ≥ staging lines for new upload.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "normalized-import-execution-plan.md"),
    [
      "# Normalized import execution plan",
      "",
      "## Preconditions",
      "",
      "1. `APPROVED_TO_RUN_STAGING=true` + `APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=true`",
      "2. Both uploads `synthetic_upload_ready` with `content_sha256`",
      "3. Staging ref `eiqfaapyumhixxoeltgu` only",
      "",
      "## Script (to implement)",
      "",
      "`scripts/removal-normalized-import-staging-execute.ts`",
      "",
      "## Steps (order matters)",
      "",
      "```text",
      "1. REMOVAL_ORDER upload",
      "   runReportsApiImportPipeline({ uploadId, organizationId, runPipeline: true })",
      "   OR manual: POST /api/settings/imports/process → sync (no generic)",
      "",
      "2. REMOVAL_SHIPMENT upload",
      "   runReportsApiImportPipeline({ uploadId, organizationId, runPipeline: true })",
      "   Phase 4: removal_shipment_tree → rebuild_shipment_tree + expected_packages generic",
      "",
      "3. Verify counts on amazon_removals / amazon_removal_shipments for upload_ids",
      "```",
      "",
      "## API / worker entrypoints",
      "",
      "- `lib/amazon/reports-api-pipeline-handoff.ts` — `runReportsApiImportPipeline`",
      "- Resume with `runPipeline: true` on removal-order/shipment workers if source_run stuck at `synthetic_upload_ready`",
      "- In-process routes: `executeAmazonPhase2Staging`, `/api/settings/imports/sync`, `/api/settings/imports/generic`",
      "",
      "## Forbidden",
      "",
      "- No `products.insert` / `product_identifier_map.insert`",
      "- No resolver backfill in same transaction (separate prompt)",
      "- No original/production DB",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rebuild-execution-plan.md"),
    [
      "# Rebuild execution plan",
      "",
      "## When",
      "",
      "After **both** REMOVAL_ORDER and REMOVAL_SHIPMENT domain syncs succeed for the target store.",
      "",
      "## Function",
      "",
      "```sql",
      "SELECT * FROM public.rebuild_expected_packages_from_removals(",
      "  p_organization_id := '<org_uuid>',",
      "  p_store_id := '<store_uuid>'",
      ");",
      "```",
      "",
      "## Expected effects",
      "",
      "- Upsert `expected_packages` with `build_source` ∈ (`detail_shipment`, `detail_remainder`)",
      "- Delete obsolete derived rows in scope",
      "- Does **not** set `resolved_product_id` (resolver backfill is separate)",
      "",
      "## Verification",
      "",
      "- Compare `matched_rows_upserted`, `remainder_rows_upserted`, `overflow_lines` to plan",
      "- Spot-check join: detail×shipment 7-tuple (see removal-intake plans)",
      "",
      "## Rollback note",
      "",
      "Re-run rebuild is idempotent; domain tables are source of truth for derived EP rows.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const nextPrompt = uploadsReady
    ? "REMOVAL-NORMALIZED-IMPORT-STAGING-EXECUTE — run Phase 2–4 on ready REMOVAL_ORDER then REMOVAL_SHIPMENT uploads, then rebuild_expected_packages_from_removals"
    : "SP-API-REMOVAL-REPORTS-FETCH-RETRY — resolve report_fatal until synthetic_upload_ready for both reports, then re-run this plan";

  const manifest = {
    prompt: "REMOVAL NORMALIZED IMPORT PLAN AFTER FETCH",
    run_id: runId,
    fetch_run_id: fetchRunId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    uploads_ready: uploadsReady,
    fetch_order_fetched: fetchOrderOk,
    fetch_shipment_fetched: fetchShipmentOk,
    order_rows_preview: orderPreview,
    shipment_rows_preview: shipmentPreview,
    approval_file: APPROVAL_PATH,
    exact_next_prompt: nextPrompt,
    forbidden: { db_writes: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        uploads_ready: uploadsReady,
        order_rows_preview: orderPreview,
        shipment_rows_preview: shipmentPreview,
        approval_file: APPROVAL_PATH,
        blockers: blockers.length,
        next_prompt: nextPrompt,
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
