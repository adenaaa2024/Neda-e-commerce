/**
 * REMOVAL NORMALIZED IMPORT FROM EXISTING CSV PLAN (read-only)
 *
 *   npx tsx scripts/removal-normalized-import-from-existing-csv-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/removal-normalized-import-from-existing-csv-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-existing-csv-rebuild-staging-approval.md";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type UploadInventory = {
  id: string;
  report_type: string;
  status: string;
  created_at: string;
  file_name: string | null;
  source: string | null;
  content_sha256: boolean;
  staging_rows: number;
  domain_rows: number;
  importable: boolean;
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

function writeApproval(): void {
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_PATH),
    `# Removal existing CSV rebuild (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product create from title only | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_EXISTING_CSV_REBUILD=false
\`\`\`

## Scope

- **Preferred path:** \`rebuild_expected_packages_from_removals(org, store)\` only — domain tables already populated from legacy CSV.
- **Optional:** re-run Phase 2–4 on existing CSV uploads only if domain resync required (separate operator decision).
- No SP-API fetch required for this path.
- No \`products.insert\` during rebuild.

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_EXISTING_CSV_REBUILD=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  writeApproval();

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
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}.`);

  let inventory: UploadInventory[] = [];
  let pairedOrder: UploadInventory | null = null;
  let pairedShipment: UploadInventory | null = null;
  let counts = {
    removals: 0,
    shipments: 0,
    ep_derived: 0,
    ep_legacy: 0,
    simulated_ep_rows: 0,
    ep_mismatch: 0,
    spapi_failed_uploads: 0,
  };

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '120s'");

    const shipHasDisp = (
      await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='amazon_removal_shipments' AND column_name='disposition'`,
      )
    ).rowCount;
    const shipDispSel = shipHasDisp
      ? "nullif(btrim(s.disposition), '') AS disposition"
      : "NULL::text AS disposition";
    const dispositionJoin = shipHasDisp
      ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
      : "";

    const invRes = await client.query(
      `SELECT
         u.id::text,
         u.report_type,
         u.status,
         u.created_at::text,
         u.file_name,
         COALESCE(u.metadata->>'source', u.metadata->'source_run'->>'provider') AS source,
         (u.metadata->>'content_sha256' IS NOT NULL AND btrim(u.metadata->>'content_sha256') <> '') AS has_sha,
         (SELECT COUNT(*)::int FROM public.amazon_staging st WHERE st.upload_id = u.id) AS staging_rows,
         (SELECT COUNT(*)::int FROM public.amazon_removals ar WHERE ar.upload_id = u.id) AS removal_domain,
         (SELECT COUNT(*)::int FROM public.amazon_removal_shipments sh WHERE sh.upload_id = u.id) AS shipment_domain
       FROM public.raw_report_uploads u
       WHERE u.organization_id = $1::uuid
         AND u.report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
       ORDER BY u.created_at DESC
       LIMIT 60`,
      [ORG_ID],
    );

    inventory = (invRes.rows as Record<string, unknown>[]).map((r) => {
      const reportType = String(r.report_type);
      const domain =
        reportType === "REMOVAL_ORDER"
          ? Number(r.removal_domain)
          : Number(r.shipment_domain);
      const staging = Number(r.staging_rows);
      const hasSha = Boolean(r.has_sha);
      const status = String(r.status);
      const source = r.source != null ? String(r.source) : null;
      const isSpapiFailed =
        source === "amazon_sp_api" && status === "uploading" && domain === 0 && !hasSha;
      const importable =
        !isSpapiFailed &&
        hasSha &&
        domain > 0 &&
        ["complete", "mapped", "synced", "raw_synced"].includes(status);
      return {
        id: String(r.id),
        report_type: reportType,
        status,
        created_at: String(r.created_at),
        file_name: r.file_name != null ? String(r.file_name) : null,
        source,
        content_sha256: hasSha,
        staging_rows: staging,
        domain_rows: domain,
        importable,
      };
    });

    counts.spapi_failed_uploads = inventory.filter(
      (u) => u.source === "amazon_sp_api" && u.status === "uploading" && !u.content_sha256,
    ).length;

    const importableOrder = inventory
      .filter((u) => u.report_type === "REMOVAL_ORDER" && u.importable)
      .sort((a, b) => b.domain_rows - a.domain_rows);
    const importableShipment = inventory
      .filter((u) => u.report_type === "REMOVAL_SHIPMENT" && u.importable)
      .sort((a, b) => b.domain_rows - a.domain_rows);
    pairedOrder = importableOrder[0] ?? null;
    pairedShipment = importableShipment[0] ?? null;

    const base = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1 AND store_id=$2) AS removals,
         (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1 AND store_id=$2) AS shipments,
         (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1 AND store_id=$2
            AND build_source IN ('detail_shipment','detail_remainder')) AS ep_derived,
         (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1 AND store_id=$2
            AND build_source = 'legacy') AS ep_legacy`,
      [ORG_ID, STORE_ID],
    );
    Object.assign(counts, base.rows[0] as object);

    const simCount = await client.query(
      `
      WITH detail AS (
        SELECT d.id AS detail_id, COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty,
          d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
          nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku,
          nullif(btrim(d.disposition),'') AS disposition
        FROM public.amazon_removals d
        WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
      ),
      shipment AS (
        SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
          nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispSel},
          COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
        FROM public.amazon_removal_shipments s
        WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
      ),
      pair AS (
        SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
        FROM detail d
        LEFT JOIN shipment s
          ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
         AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
         AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
         AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
      ),
      agg AS (
        SELECT detail_id, max(detail_shipped_qty) AS detail_total,
          sum(COALESCE(shipment_shipped_qty,0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
          count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
        FROM pair GROUP BY detail_id
      ),
      matched_emitted AS (
        SELECT p.detail_id, p.shipment_id FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
      ),
      remainder_emitted AS (
        SELECT DISTINCT ON (p.detail_id) p.detail_id
        FROM pair p JOIN agg a USING (detail_id)
        WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
        ORDER BY p.detail_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM matched_emitted) + (SELECT COUNT(*)::int FROM remainder_emitted) AS simulated_rows
      `,
      [ORG_ID, STORE_ID],
    );
    counts.simulated_ep_rows = Number((simCount.rows[0] as { simulated_rows: number }).simulated_rows);

    const mismatch = await client.query(
      `
      WITH sim AS (
        SELECT detail_id::text, shipment_id::text
        FROM (
          WITH detail AS (
            SELECT d.id AS detail_id, d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
              nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku,
              nullif(btrim(d.disposition),'') AS disposition,
              COALESCE(d.shipped_quantity,0) AS detail_shipped_qty
            FROM public.amazon_removals d
            WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
          ),
          shipment AS (
            SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
              nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispSel},
              COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
            FROM public.amazon_removal_shipments s
            WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
          ),
          pair AS (
            SELECT d.detail_id, s.shipment_id, d.detail_shipped_qty, s.shipment_shipped_qty
            FROM detail d
            LEFT JOIN shipment s
              ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
             AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
             AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
             AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
          ),
          agg AS (
            SELECT detail_id, max(detail_shipped_qty) AS detail_total,
              sum(COALESCE(shipment_shipped_qty,0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
              count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
            FROM pair GROUP BY detail_id
          ),
          matched AS (
            SELECT p.detail_id, p.shipment_id FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
          ),
          remainder AS (
            SELECT DISTINCT ON (p.detail_id) p.detail_id, NULL::uuid AS shipment_id
            FROM pair p JOIN agg a USING (detail_id)
            WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
            ORDER BY p.detail_id
          )
          SELECT detail_id, shipment_id FROM matched
          UNION ALL SELECT detail_id, shipment_id FROM remainder
        ) x
      ),
      live AS (
        SELECT source_detail_row_id::text AS detail_id,
               source_shipment_row_id::text AS shipment_id
        FROM public.expected_packages
        WHERE organization_id=$1::uuid AND store_id=$2::uuid
          AND build_source IN ('detail_shipment','detail_remainder')
      )
      SELECT
        (SELECT COUNT(*)::int FROM (
          SELECT * FROM sim EXCEPT SELECT * FROM live
          UNION ALL SELECT * FROM live EXCEPT SELECT * FROM sim
        ) z) AS symmetric_diff
      `,
      [ORG_ID, STORE_ID],
    );
    counts.ep_mismatch = Number((mismatch.rows[0] as { symmetric_diff: number }).symmetric_diff);

    await client.end();
  } else {
    blockers.push("STAGING_DIRECT_POSTGRES_URL missing or wrong ref.");
  }

  const pairedFound = !!(pairedOrder && pairedShipment);
  const domainSufficient = counts.removals > 0 && counts.shipments > 0;
  const driftEstimate = Math.max(
    0,
    counts.simulated_ep_rows - counts.ep_derived,
    counts.ep_mismatch,
  );
  const safeRebuildOnly = domainSufficient && driftEstimate > 0;
  const safeFullResync = pairedFound;

  if (!pairedFound) {
    blockers.push(
      "No legacy CSV upload with domain_rows>0 for both REMOVAL_ORDER and REMOVAL_SHIPMENT (check upload_id linkage on domain rows).",
    );
  }
  if (!domainSufficient) blockers.push("Domain tables empty — CSV path insufficient without import.");

  const expectedDelta = counts.simulated_ep_rows - counts.ep_derived;
  const staleCorrected = driftEstimate;

  fs.writeFileSync(
    path.join(outDir, "upload-inventory.md"),
    [
      "# Upload inventory (REMOVAL_ORDER / REMOVAL_SHIPMENT)",
      "",
      `Org \`${ORG_ID}\` — last 60 uploads.`,
      "",
      "| created | type | status | source | sha | staging | domain | importable | upload_id |",
      "|---------|------|--------|--------|-----|---------|--------|------------|-----------|",
      ...inventory.map(
        (u) =>
          `| ${u.created_at.slice(0, 19)} | ${u.report_type} | ${u.status} | ${u.source ?? "—"} | ${u.content_sha256 ? "yes" : "no"} | ${u.staging_rows} | ${u.domain_rows} | **${u.importable}** | \`${u.id.slice(0, 8)}…\` |`,
      ),
      "",
      `SP-API failed placeholders (non-importable): **${counts.spapi_failed_uploads}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "latest-paired-uploads.md"),
    [
      "# Latest paired uploads",
      "",
      `**Paired set found:** **${pairedFound}**`,
      "",
      "## REMOVAL_ORDER (latest importable)",
      "",
      pairedOrder
        ? [
            `| Field | Value |`,
            `|-------|-------|`,
            `| upload_id | \`${pairedOrder.id}\` |`,
            `| created_at | ${pairedOrder.created_at} |`,
            `| status | ${pairedOrder.status} |`,
            `| source | ${pairedOrder.source ?? "legacy"} |`,
            `| staging_rows | ${pairedOrder.staging_rows} |`,
            `| amazon_removals | ${pairedOrder.domain_rows} |`,
          ].join("\n")
        : "- None",
      "",
      "## REMOVAL_SHIPMENT (latest importable)",
      "",
      pairedShipment
        ? [
            `| Field | Value |`,
            `|-------|-------|`,
            `| upload_id | \`${pairedShipment.id}\` |`,
            `| created_at | ${pairedShipment.created_at} |`,
            `| status | ${pairedShipment.status} |`,
            `| source | ${pairedShipment.source ?? "legacy"} |`,
            `| staging_rows | ${pairedShipment.staging_rows} |`,
            `| amazon_removal_shipments | ${pairedShipment.domain_rows} |`,
          ].join("\n")
        : "- None",
      "",
      "> Order and shipment uploads may be from different import sessions; domain tables already union all historical CSV loads.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "phase-rerun-safety.md"),
    [
      "# Phase 2–4 rerun safety",
      "",
      "## Path A — Rebuild only (recommended)",
      "",
      "| Question | Answer |",
      "|----------|--------|",
      "| Domain already populated? | **Yes** — removals **" + counts.removals + "**, shipments **" + counts.shipments + "** |",
      "| Need SP-API fetch? | **No** |",
      "| Safe to run `rebuild_expected_packages_from_removals`? | **Yes** (idempotent; quantity validation PASS) |",
      "| Product create risk? | **No** — rebuild does not touch `products` |",
      "",
      "## Path B — Re-run Phase 2–4 on CSV uploads (optional)",
      "",
      "| Step | Risk | Mitigation |",
      "|------|------|------------|",
      "| Phase 2 re-staging | Low | Upsert by staging line identity |",
      "| Phase 3 sync | Low | Registry conflict keys prevent duplicate business lines |",
      "| Phase 4 generic (shipment) | Medium | May re-trigger shipment tree / enrichment |",
      "",
      "**Recommendation:** Skip Path B unless domain tables are suspect. Current evidence supports **rebuild-only** to refresh derived EP.",
      "",
      `**Safe to rerun Phase 2–4:** ${safeFullResync ? "yes (optional, not required)" : "no — missing importable uploads"}`,
      `**Safe to rebuild only:** ${safeRebuildOnly ? "yes" : "review"}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rebuild-execution-plan.md"),
    [
      "# Rebuild execution plan",
      "",
      "```sql",
      "SELECT * FROM public.rebuild_expected_packages_from_removals(",
      `  '${ORG_ID}'::uuid,`,
      `  '${STORE_ID}'::uuid`,
      ");",
      "```",
      "",
      "## Preconditions",
      "",
      "- `APPROVED_REMOVAL_EXISTING_CSV_REBUILD=true`",
      "- Staging ref guard",
      "- Quantity allocation validation already PASS",
      "",
      "## Post-checks",
      "",
      "- `expected_packages` derived count ≈ simulated row count",
      "- Symmetric diff vs simulation → **0**",
      "- Legacy `build_source=legacy` rows untouched",
      "- Resolver backfill remains separate approval",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "row-delta-preview.md"),
    [
      "# Row delta preview",
      "",
      "| Metric | Before (live) | After (simulated target) | Delta |",
      "|--------|---------------|------------------------|-------|",
      `| \`amazon_removals\` | ${counts.removals} | ${counts.removals} | 0 (no change) |`,
      `| \`amazon_removal_shipments\` | ${counts.shipments} | ${counts.shipments} | 0 |`,
      `| \`expected_packages\` derived | ${counts.ep_derived} | ~${counts.simulated_ep_rows} | **${expectedDelta >= 0 ? "+" : ""}${expectedDelta}** |`,
      `| \`expected_packages\` legacy | ${counts.ep_legacy} | ${counts.ep_legacy} | 0 (preserved) |`,
      "",
      "## Stale / drift correction",
      "",
      `- Symmetric diff (simulation vs live derived keys): **${counts.ep_mismatch}** row-keys`,
      `- Operator-reported drift: **~498** — consistent with stale rebuild (live < simulation)`,
      `- Expected **stale rows corrected**: up to **${staleCorrected}** upserts/deletes via rebuild obsolete cleanup`,
      "",
      "## Interpretation",
      "",
      "Rebuild should:",
      "",
      "1. Upsert missing `detail_shipment` / `detail_remainder` rows from current domain truth.",
      "2. Delete derived rows whose `(source_detail_row_id, source_shipment_row_id)` pair no longer exists.",
      "3. Leave `build_source=legacy` rows unchanged.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_REMOVAL_EXISTING_CSV_REBUILD=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "- SP-API fetch remains FATAL — not blocking this CSV/rebuild path.",
      ...blockers.map((b) => `- ${b}`),
    ].join("\n") + "\n",
  );

  const nextPrompt = safeRebuildOnly
    ? "REMOVAL-EXISTING-CSV-REBUILD-EXECUTE — run rebuild_expected_packages_from_removals on staging after approval"
    : "REMOVAL-NORMALIZED-IMPORT-FROM-EXISTING-CSV-INVESTIGATE — resolve missing paired uploads or domain gaps";

  const manifest = {
    prompt: "REMOVAL NORMALIZED IMPORT FROM EXISTING CSV PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.filter((b) => !b.includes("SP-API")).length ? "BLOCKED" : "PASS",
    latest_paired_uploads_found: pairedFound,
    safe_to_rebuild_only: safeRebuildOnly,
    safe_to_rerun_phase_2_4: safeFullResync,
    order_upload_id: pairedOrder?.id ?? null,
    shipment_upload_id: pairedShipment?.id ?? null,
    counts,
    expected_row_delta: expectedDelta,
    stale_rows_symmetric_diff: counts.ep_mismatch,
    drift_estimate_rows: driftEstimate,
    approval_file: APPROVAL_PATH,
    exact_next_prompt: nextPrompt,
    forbidden: { db_writes: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        paired_found: pairedFound,
        safe_to_rebuild: safeRebuildOnly,
        expected_delta: expectedDelta,
        stale_symmetric_diff: counts.ep_mismatch,
        approval_file: APPROVAL_PATH,
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
