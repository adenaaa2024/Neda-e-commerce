/**
 * SP-API REMOVAL REPORTS SYNC PLAN — raw uploads → domain (read-only)
 *
 *   npx tsx scripts/sp-api-removal-reports-sync-plan.ts --run-id=<UTC_Z>
 *   npx tsx scripts/sp-api-removal-reports-sync-plan.ts --fetch-run-id=20260527T202818Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  mapRowToAmazonRemoval,
  mapRowToAmazonRemovalShipment,
} from "../lib/import-sync-mappers";
import { removalAmazonRemovalsBusinessDedupKey } from "../lib/pipeline/amazon-removals-business-key";
import { removalShipmentArchiveBusinessKey } from "../lib/pipeline/removal-shipment-archive-key";
import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const FETCH_BASE = ".cursor/audit-reports/sp-api-removal-reports-fetch-execute";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-reports-sync-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const ORDER_UPLOAD_ID = "7a7a9a49-7edf-4ace-a77b-b17f9882f8a2";
const SHIPMENT_UPLOAD_ID = "839817be-f65f-4cb8-9fc0-2cda49a3ab67";

type MappedRow = Record<string, unknown>;

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
    `# SP-API removal reports domain sync (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product create from title only | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC=false
\`\`\`

## Scope

- Phase 2 staging → Phase 3 sync for SP-API synthetic \`REMOVAL_ORDER\` + \`REMOVAL_SHIPMENT\` uploads
- Phase 4 generic (shipment upload): \`rebuild_shipment_tree_from_removal_shipments\` + enrichment patch
- \`rebuild_expected_packages_from_removals(org, store)\` after domain sync
- Resolve \`product_id\` read-only where possible; queue promotion plan only for missing products
- No \`products.insert\` / no \`product_identifier_map.insert\` in this execute pass

## Preconditions

- SP-API fetch execute PASS with \`synthetic_upload_ready\` for both report types
- Allocation fix verify PASS recommended before rebuild (see removal-rebuild-allocation-fix)

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

function parseTsv(text: string, headers: string[]): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split("\t");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = cells[j] ?? "";
    }
    out.push(row);
  }
  return out;
}

async function downloadTsv(objectKey: string): Promise<string> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await supabase.storage.from("raw-reports").download(objectKey);
  if (error || !data) throw new Error(`download failed ${objectKey}: ${error?.message}`);
  return data.text();
}

async function loadUploadMeta(
  client: pg.Client,
  uploadId: string,
): Promise<{ object_key: string; headers: string[]; report_type: string }> {
  const r = await client.query(
    `SELECT report_type, metadata
     FROM public.raw_report_uploads WHERE id = $1::uuid`,
    [uploadId],
  );
  const row = r.rows[0] as { report_type: string; metadata: Record<string, unknown> } | undefined;
  if (!row) throw new Error(`upload not found: ${uploadId}`);
  const meta = row.metadata ?? {};
  const sr =
    meta.source_run && typeof meta.source_run === "object"
      ? (meta.source_run as Record<string, unknown>)
      : null;
  const archive =
    sr?.archive && typeof sr.archive === "object"
      ? (sr.archive as Record<string, unknown>)
      : null;
  const objectKey = String(archive?.object_key ?? "");
  if (!objectKey) throw new Error(`no object_key for upload ${uploadId}`);
  const headers = Array.isArray(meta.csv_headers)
    ? meta.csv_headers.filter((h): h is string => typeof h === "string")
    : [];
  return { object_key: objectKey, headers, report_type: String(row.report_type) };
}

async function loadExistingRemovalKeys(client: pg.Client): Promise<Set<string>> {
  const r = await client.query(
    `SELECT organization_id, store_id, order_id, sku, fnsku, disposition,
            requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
            order_date::text, order_type
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG_ID, STORE_ID],
  );
  const keys = new Set<string>();
  for (const row of r.rows as Record<string, unknown>[]) {
    keys.add(removalAmazonRemovalsBusinessDedupKey(row));
  }
  return keys;
}

async function loadExistingShipmentArchiveKeys(
  client: pg.Client,
  excludeUploadId: string,
): Promise<Set<string>> {
  const r = await client.query(
    `SELECT organization_id, store_id, order_id, tracking_number, sku, fnsku, disposition,
            requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
            order_date::text, order_type, carrier, shipment_date::text
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upload_id <> $3::uuid`,
    [ORG_ID, STORE_ID, excludeUploadId],
  );
  const keys = new Set<string>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const k = removalShipmentArchiveBusinessKey(row);
    if (k) keys.add(k);
  }
  return keys;
}

type ProductMapIndex = {
  byFnsku: Map<string, string>;
  bySku: Map<string, string>;
};

async function loadProductMapIndex(client: pg.Client): Promise<ProductMapIndex> {
  const byFnsku = new Map<string, string>();
  const bySku = new Map<string, string>();
  const r = await client.query(
    `SELECT product_id::text, fnsku, seller_sku, msku
     FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [ORG_ID, STORE_ID],
  );
  for (const row of r.rows as {
    product_id: string;
    fnsku: string | null;
    seller_sku: string | null;
    msku: string | null;
  }[]) {
    const fnsku = row.fnsku?.trim();
    if (fnsku) byFnsku.set(fnsku, row.product_id);
    for (const sku of [row.seller_sku, row.msku]) {
      const s = sku?.trim();
      if (s) bySku.set(s, row.product_id);
    }
  }
  return { byFnsku, bySku };
}

function resolveProductId(
  row: MappedRow,
  map: ProductMapIndex,
): { product_id: string | null; tier: string | null } {
  const fnsku = row.fnsku != null ? String(row.fnsku).trim() : "";
  const sku = row.sku != null ? String(row.sku).trim() : "";
  if (fnsku && map.byFnsku.has(fnsku)) {
    return { product_id: map.byFnsku.get(fnsku)!, tier: "fnsku" };
  }
  if (sku && map.bySku.has(sku)) {
    return { product_id: map.bySku.get(sku)!, tier: "sku" };
  }
  return { product_id: null, tier: null };
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
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}.`);

  let fetchManifest: Record<string, unknown> = {};
  if (fs.existsSync(path.join(fetchDir, "manifest.json"))) {
    fetchManifest = JSON.parse(fs.readFileSync(path.join(fetchDir, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } else {
    blockers.push(`Fetch manifest missing: ${FETCH_BASE}/${fetchRunId}/manifest.json`);
  }

  if (fetchManifest.order_report_fetched !== true || fetchManifest.shipment_report_fetched !== true) {
    blockers.push("Fetch execute did not succeed for both report types.");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push("STAGING_DIRECT_POSTGRES_URL unset or wrong ref.");
  }

  const diff = {
    removal_order: {
      upload_id: ORDER_UPLOAD_ID,
      tsv_data_rows: 0,
      mapper_null: 0,
      mapper_ok: 0,
      unique_business_keys: 0,
      insert_new: 0,
      upsert_existing: 0,
      duplicate_in_batch: 0,
    },
    removal_shipment: {
      upload_id: SHIPMENT_UPLOAD_ID,
      tsv_data_rows: 0,
      mapper_null: 0,
      mapper_ok: 0,
      unique_archive_keys: 0,
      insert_new: 0,
      skip_cross_upload: 0,
      duplicate_in_batch: 0,
    },
    baseline: { removals: 0, shipments: 0, ep_derived: 0 },
    allocation_mismatch_open: false,
  };

  const productImpact = {
    order_lines_resolvable: 0,
    order_lines_unresolved: 0,
    shipment_lines_resolvable: 0,
    shipment_lines_unresolved: 0,
    promotion_candidates: [] as Array<{
      source: "removal_order" | "removal_shipment";
      sku: string | null;
      fnsku: string | null;
      order_id: string | null;
    }>,
  };

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '180s'");

    const base = await client.query(
      `SELECT
        (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid AND store_id=$2::uuid) AS removals,
        (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid AND store_id=$2::uuid) AS shipments,
        (SELECT COUNT(*)::int FROM public.expected_packages
          WHERE organization_id=$1::uuid AND store_id=$2::uuid
            AND build_source IN ('detail_shipment', 'detail_remainder')) AS ep_derived`,
      [ORG_ID, STORE_ID],
    );
    diff.baseline = base.rows[0] as typeof diff.baseline;

    const verifyPath = path.join(
      process.cwd(),
      ".cursor/audit-reports/removal-rebuild-verify-and-resolver-dryrun",
    );
    if (fs.existsSync(verifyPath)) {
      const verifyDirs = fs
        .readdirSync(verifyPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      const latestVerify = verifyDirs[0];
      if (latestVerify) {
        const mPath = path.join(verifyPath, latestVerify, "manifest.json");
        if (fs.existsSync(mPath)) {
          const vm = JSON.parse(fs.readFileSync(mPath, "utf8")) as { rebuild_valid?: boolean };
          diff.allocation_mismatch_open = vm.rebuild_valid === false;
        }
      }
    }

    const existingRemovalKeys = await loadExistingRemovalKeys(client);
    const existingShipmentKeys = await loadExistingShipmentArchiveKeys(client, SHIPMENT_UPLOAD_ID);
    const productMap = await loadProductMapIndex(client);

    // REMOVAL_ORDER dry-run
    const orderMeta = await loadUploadMeta(client, ORDER_UPLOAD_ID);
    const orderText = await downloadTsv(orderMeta.object_key);
    const orderRaw = parseTsv(orderText, orderMeta.headers);
    diff.removal_order.tsv_data_rows = orderRaw.length;

    const orderMapped: MappedRow[] = [];
    const orderKeyCounts = new Map<string, number>();
    const promotionSeen = new Set<string>();

    for (const raw of orderRaw) {
      const mapped = mapRowToAmazonRemoval(raw, ORG_ID, ORDER_UPLOAD_ID, STORE_ID);
      if (!mapped) {
        diff.removal_order.mapper_null++;
        continue;
      }
      diff.removal_order.mapper_ok++;
      const row = mapped as MappedRow;
      orderMapped.push(row);
      const bk = removalAmazonRemovalsBusinessDedupKey(row);
      orderKeyCounts.set(bk, (orderKeyCounts.get(bk) ?? 0) + 1);
      if (existingRemovalKeys.has(bk)) diff.removal_order.upsert_existing++;
      else diff.removal_order.insert_new++;

      const res = resolveProductId(row, productMap);
      if (res.product_id) productImpact.order_lines_resolvable++;
      else {
        productImpact.order_lines_unresolved++;
        const promoKey = `${row.sku}|${row.fnsku}`;
        if ((row.fnsku || row.sku) && !promotionSeen.has(promoKey)) {
          promotionSeen.add(promoKey);
          productImpact.promotion_candidates.push({
            source: "removal_order",
            sku: row.sku != null ? String(row.sku) : null,
            fnsku: row.fnsku != null ? String(row.fnsku) : null,
            order_id: row.order_id != null ? String(row.order_id) : null,
          });
        }
      }
    }
    diff.removal_order.unique_business_keys = orderKeyCounts.size;
    diff.removal_order.duplicate_in_batch = [...orderKeyCounts.values()].filter((c) => c > 1).length;

    // REMOVAL_SHIPMENT dry-run
    const shipMeta = await loadUploadMeta(client, SHIPMENT_UPLOAD_ID);
    const shipText = await downloadTsv(shipMeta.object_key);
    const shipRaw = parseTsv(shipText, shipMeta.headers);
    diff.removal_shipment.tsv_data_rows = shipRaw.length;

    const shipKeyCounts = new Map<string, number>();
    for (const raw of shipRaw) {
      const mapped = mapRowToAmazonRemovalShipment(raw, ORG_ID, SHIPMENT_UPLOAD_ID, STORE_ID);
      if (!mapped) {
        diff.removal_shipment.mapper_null++;
        continue;
      }
      diff.removal_shipment.mapper_ok++;
      const row = mapped as MappedRow;
      const ak = removalShipmentArchiveBusinessKey(row);
      if (ak) shipKeyCounts.set(ak, (shipKeyCounts.get(ak) ?? 0) + 1);
      if (ak && existingShipmentKeys.has(ak)) diff.removal_shipment.skip_cross_upload++;
      else diff.removal_shipment.insert_new++;

      const res = resolveProductId(row, productMap);
      if (res.product_id) productImpact.shipment_lines_resolvable++;
      else {
        productImpact.shipment_lines_unresolved++;
        const promoKey = `s:${row.sku}|${row.fnsku}`;
        if ((row.fnsku || row.sku) && !promotionSeen.has(promoKey)) {
          promotionSeen.add(promoKey);
          productImpact.promotion_candidates.push({
            source: "removal_shipment",
            sku: row.sku != null ? String(row.sku) : null,
            fnsku: row.fnsku != null ? String(row.fnsku) : null,
            order_id: row.order_id != null ? String(row.order_id) : null,
          });
        }
      }
    }
    diff.removal_shipment.unique_archive_keys = shipKeyCounts.size;
    diff.removal_shipment.duplicate_in_batch = [...shipKeyCounts.values()].filter((c) => c > 1).length;

    await client.end();

    fs.writeFileSync(path.join(outDir, "removal-domain-diff.json"), JSON.stringify(diff, null, 2));
    fs.writeFileSync(
      path.join(outDir, "product-promotion-needed.json"),
      JSON.stringify(
        {
          count: productImpact.promotion_candidates.length,
          note: "Plan only — no products.insert in domain sync execute",
          candidates: productImpact.promotion_candidates.slice(0, 200),
          truncated: productImpact.promotion_candidates.length > 200,
        },
        null,
        2,
      ),
    );
  }

  if (diff.allocation_mismatch_open) {
    blockers.push(
      "Open allocation verify FAIL (55 duplicate remainder mismatches) — run REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE before rebuild_expected_packages_from_removals.",
    );
  }

  const nextPrompt =
    blockers.length === 0
      ? "SP-API-REMOVAL-REPORTS-DOMAIN-SYNC-EXECUTE — Phase 2–4 on SP-API uploads, then rebuild_expected_packages_from_removals (after allocation fix if still open)"
      : diff.allocation_mismatch_open
        ? "REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE — duplicate remainder cleanup + rebuild + verify PASS, then re-run domain sync plan"
        : "SP-API-REMOVAL-REPORTS-FETCH-EXECUTE — resolve fetch preconditions, then re-run sync plan";

  fs.writeFileSync(
    path.join(outDir, "raw-to-domain-sync-plan.md"),
    [
      "# Raw → domain sync plan",
      "",
      `**Fetch run:** \`${FETCH_BASE}/${fetchRunId}\``,
      `**Staging:** \`${STAGING_REF}\``,
      "",
      "## Source uploads (SP-API synthetic)",
      "",
      "| Report | upload_id | TSV rows |",
      "|--------|-----------|----------|",
      `| REMOVAL_ORDER | \`${ORDER_UPLOAD_ID}\` | ${diff.removal_order.tsv_data_rows} |`,
      `| REMOVAL_SHIPMENT | \`${SHIPMENT_UPLOAD_ID}\` | ${diff.removal_shipment.tsv_data_rows} |`,
      "",
      "## Phase 3 dry-run (mapper simulation, no DB writes)",
      "",
      "### REMOVAL_ORDER → `amazon_removals`",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| Mapper OK | ${diff.removal_order.mapper_ok} |`,
      `| Mapper null (skipped) | ${diff.removal_order.mapper_null} |`,
      `| Unique business keys | ${diff.removal_order.unique_business_keys} |`,
      `| **Insert new** (key not in domain) | **${diff.removal_order.insert_new}** |`,
      `| **Upsert existing** (conflict on \`uq_amazon_removals_business_line\`) | **${diff.removal_order.upsert_existing}** |`,
      `| Duplicate keys in batch | ${diff.removal_order.duplicate_in_batch} |`,
      "",
      "### REMOVAL_SHIPMENT → `amazon_removal_shipments`",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| Mapper OK | ${diff.removal_shipment.mapper_ok} |`,
      `| Mapper null | ${diff.removal_shipment.mapper_null} |`,
      `| Unique archive keys | ${diff.removal_shipment.unique_archive_keys} |`,
      `| **Insert new** | **${diff.removal_shipment.insert_new}** |`,
      `| **Skip cross-upload duplicate** | **${diff.removal_shipment.skip_cross_upload}** |`,
      `| Duplicate keys in batch | ${diff.removal_shipment.duplicate_in_batch} |`,
      "",
      "## Baseline domain (pre-sync)",
      "",
      `- \`amazon_removals\`: **${diff.baseline.removals}** (legacy CSV + prior imports)`,
      `- \`amazon_removal_shipments\`: **${diff.baseline.shipments}**`,
      `- \`expected_packages\` derived: **${diff.baseline.ep_derived}**`,
      "",
      "## Execute sequence (when approved)",
      "",
      "1. **Phase 2** — stage TSV → `amazon_staging` for each upload (`runReportsApiImportPipeline` or process route)",
      "2. **Phase 3** — REMOVAL_ORDER sync → `amazon_removals` (business-line upsert)",
      "3. **Phase 3** — REMOVAL_SHIPMENT sync → `amazon_removal_shipments` (per-upload row_number + cross-upload skip)",
      "4. **Phase 4** — shipment upload only: generic `removal_shipment_tree` + enrichment patch to removals",
      "5. **Rebuild** — `rebuild_expected_packages_from_removals(org, store)` (separate step in execute prompt)",
      "",
      "## Join contract (unchanged)",
      "",
      "`organization_id + store_id + order_id + order_type + order_date + sku + fnsku + disposition`",
      "",
      "Tracking/carrier/shipment_date attach at container grain after line match — not SKU-only join.",
      "",
      "## Forbidden in execute",
      "",
      "- No `products.insert`",
      "- No `product_identifier_map.insert`",
      "- No original/production DB",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "expected-packages-rebuild-plan.md"),
    [
      "# Expected packages rebuild plan (post domain sync)",
      "",
      "## When",
      "",
      "After both SP-API uploads complete Phase 2–4 and domain row counts verified.",
      "",
      "## Prerequisite",
      "",
      diff.allocation_mismatch_open
        ? "**BLOCKED** — allocation verify still FAIL; run allocation fix execute first."
        : "Allocation verify PASS (or allocation fix completed).",
      "",
      "## Function",
      "",
      "```sql",
      "SELECT * FROM public.rebuild_expected_packages_from_removals(",
      `  p_organization_id := '${ORG_ID}',`,
      `  p_store_id := '${STORE_ID}'`,
      ");",
      "```",
      "",
      "## Expected delta (estimate)",
      "",
      `- Net new removal order lines vs legacy: up to **${diff.removal_order.insert_new}** domain inserts + upsert refreshes`,
      `- Net new shipment lines vs legacy: up to **${diff.removal_shipment.insert_new}** (after **${diff.removal_shipment.skip_cross_upload}** cross-upload skips)`,
      `- Derived EP rows will re-simulate from full domain; expect change proportional to new/changed detail×shipment matches`,
      "",
      "## Post-rebuild",
      "",
      "1. Re-run `removal-rebuild-verify-and-resolver-dryrun.ts` — gate: `rebuild_valid=yes`",
      "2. Resolver backfill dry-run / execute (separate approval)",
      "3. PC03D evidence queue for unresolved promotion candidates",
      "",
      "## Does not",
      "",
      "- Set `resolved_product_id` (resolver backfill is separate)",
      "- Create products",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "product-resolution-impact.md"),
    [
      "# Product resolution impact (read-only dry-run)",
      "",
      "## Policy",
      "",
      "- Resolve existing `product_id` via `product_identifier_map` (FNSKU → SKU tiers only in this plan pass)",
      "- Missing product → **promotion plan queue only**, no execute",
      "",
      "## REMOVAL_ORDER mapped lines",
      "",
      `- Resolvable via map: **${productImpact.order_lines_resolvable}**`,
      `- Unresolved (needs evidence / promotion plan): **${productImpact.order_lines_unresolved}**`,
      "",
      "## REMOVAL_SHIPMENT mapped lines",
      "",
      `- Resolvable via map: **${productImpact.shipment_lines_resolvable}**`,
      `- Unresolved: **${productImpact.shipment_lines_unresolved}**`,
      "",
      "## Promotion candidates (unique sku/fnsku pairs)",
      "",
      `- Count: **${productImpact.promotion_candidates.length}** (see \`product-promotion-needed.json\`)`,
      "",
      "## Execute guard",
      "",
      "Domain sync execute must **not** call `products.insert` or `product_identifier_map.insert`.",
      "Post-rebuild resolver backfill uses governed tiers only (separate approval).",
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
      "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const manifest = {
    prompt: "SP-API-REMOVAL-REPORTS-SYNC-PLAN",
    run_id: runId,
    fetch_run_id: fetchRunId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    upload_ids: { removal_order: ORDER_UPLOAD_ID, removal_shipment: SHIPMENT_UPLOAD_ID },
    new_removal_order_rows: diff.removal_order.insert_new,
    upsert_removal_order_rows: diff.removal_order.upsert_existing,
    new_removal_shipment_rows: diff.removal_shipment.insert_new,
    skip_shipment_cross_upload: diff.removal_shipment.skip_cross_upload,
    product_promotion_candidates: productImpact.promotion_candidates.length,
    approval_file: APPROVAL_PATH,
    exact_next_prompt: nextPrompt,
    forbidden: { db_writes: true },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        new_removal_order_rows: diff.removal_order.insert_new,
        new_removal_shipment_rows: diff.removal_shipment.insert_new,
        product_promotion_candidates: productImpact.promotion_candidates.length,
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
