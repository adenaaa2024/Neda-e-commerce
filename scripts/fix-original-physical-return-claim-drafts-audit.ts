/**
 * FIX_ORIGINAL_PHYSICAL_RETURN_CLAIM_DRAFTS — read-only audit (original + staging compare).
 *   npx tsx scripts/fix-original-physical-return-claim-drafts-audit.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const KNOWN_IDS = [
  "bd5bf0d6-500a-4696-80c6-7c0e65f539b6",
  "9365d0e7-55e4-4bc7-9ab2-602cdc6bb496",
  "2df96a52-b699-4f95-b42c-132306b44ac5",
];

const CLAIMABLE_CONDITION_TAGS = [
  "damaged_product",
  "scratched",
  "wrong_item",
  "wrong_item_different",
  "wrong_item_junk",
  "expired",
  "missing_parts",
  "missing_item",
  "empty_box",
  "damaged_box",
  "damaged_warehouse",
  "damaged_customer",
  "damaged_carrier",
  "wet",
  "counterfeit_suspect",
  "operator_other",
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromPgUrl(url: string): string | null {
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? refFromSupabaseUrl(url);
}

async function q<T extends pg.QueryResultRow>(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await client.query<T>(sql, params);
  return res.rows;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!originalUrl || !stagingUrl) {
    throw new Error("ORIGINAL_DIRECT_POSTGRES_URL and STAGING_DIRECT_POSTGRES_URL required");
  }
  if (refFromPgUrl(originalUrl) !== ORIGINAL_REF) {
    throw new Error(`ORIGINAL URL must target ${ORIGINAL_REF}`);
  }
  if (refFromPgUrl(stagingUrl) !== STAGING_REF) {
    throw new Error(`STAGING URL must target ${STAGING_REF}`);
  }

  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/fix-original-physical-return-claim-drafts",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const orig = new pg.Client({ connectionString: originalUrl });
  const stag = new pg.Client({ connectionString: stagingUrl });
  await orig.connect();
  await stag.connect();

  const claimableArr = CLAIMABLE_CONDITION_TAGS;
  const physicalSql = `
    ri.deleted_at IS NULL
    AND ri.organization_id = $1::uuid
    AND ri.package_id IS NOT NULL
    AND NOT (
      ri.expected_item_id IS NOT NULL
      AND ri.package_id IS NULL
      AND ri.pallet_id IS NULL
    )
    AND ri.conditions && $2::text[]
  `;

  const manifest: Record<string, unknown> = { run_id: rid, org_id: ORG_ID };

  try {
    const countsOriginal = await q(
      orig,
      `
      SELECT
        (SELECT count(*)::int FROM return_items WHERE organization_id = $1) AS total,
        (SELECT count(*)::int FROM return_items WHERE organization_id = $1 AND deleted_at IS NULL) AS active,
        (SELECT count(*)::int FROM return_items WHERE organization_id = $1 AND deleted_at IS NOT NULL) AS deleted,
        (SELECT count(*)::int FROM return_items ri WHERE ${physicalSql}) AS physical_claimable_anchor,
        (SELECT count(*)::int FROM return_items ri WHERE ri.organization_id = $1 AND ri.deleted_at IS NULL AND ri.package_id IS NULL) AS active_no_package,
        (SELECT count(*)::int FROM return_items ri WHERE ri.organization_id = $1 AND ri.deleted_at IS NULL AND ri.resolved_product_id IS NULL AND ri.resolved_catalog_product_id IS NULL) AS active_no_resolved_product,
        (SELECT count(*)::int FROM return_items ri WHERE ri.organization_id = $1 AND ri.deleted_at IS NULL AND ri.expected_item_id IS NULL AND ri.package_id IS NOT NULL) AS active_pkg_no_expected,
        (SELECT count(*)::int FROM claim_candidates WHERE organization_id = $1) AS claim_candidates_total,
        (SELECT count(*)::int FROM claim_cases WHERE organization_id = $1) AS claim_cases_total,
        (SELECT count(*)::int FROM claim_submissions WHERE organization_id = $1) AS claim_submissions_total
      `,
      [ORG_ID, claimableArr],
    );
    manifest.original_counts = countsOriginal[0];

    const statusBreakdown = await q(
      orig,
      `SELECT coalesce(status,'(null)') AS status, count(*)::int AS n
       FROM return_items WHERE organization_id = $1 AND deleted_at IS NULL
       GROUP BY 1 ORDER BY n DESC`,
      [ORG_ID],
    );
    manifest.original_return_items_by_status = statusBreakdown;

    const candidatesBySource = await q(
      orig,
      `SELECT coalesce(source_table,'(null)') AS source_table, count(*)::int AS n
       FROM claim_candidates WHERE organization_id = $1
       GROUP BY 1 ORDER BY n DESC`,
      [ORG_ID],
    );
    manifest.original_claim_candidates_by_source_table = candidatesBySource;

    let draftsBySource: { source_table: string; n: number }[] = [];
    try {
      draftsBySource = await q(
        orig,
        `SELECT coalesce(source_table,'(null)') AS source_table, count(*)::int AS n
         FROM claim_candidate_drafts WHERE organization_id = $1
         GROUP BY 1 ORDER BY n DESC`,
        [ORG_ID],
      );
    } catch {
      draftsBySource = [];
    }
    manifest.original_claim_candidate_drafts_by_source_table = draftsBySource;

    const orgSettings = await q(
      orig,
      `SELECT organization_id, company_display_name, claim_policy
       FROM organization_settings WHERE organization_id = $1`,
      [ORG_ID],
    );
    manifest.original_organization_settings = orgSettings[0] ?? null;

    let workspaceSettings: unknown[] = [];
    try {
      workspaceSettings = await q(
        orig,
        `SELECT *
         FROM workspace_settings
         WHERE organization_id = $1
         LIMIT 20`,
        [ORG_ID],
      );
    } catch {
      workspaceSettings = [];
    }
    manifest.original_workspace_settings_sample = workspaceSettings;

    const stagingIds = (
      await q<{ id: string }>(
        stag,
        `SELECT id::text FROM return_items WHERE organization_id = $1 AND deleted_at IS NULL`,
        [ORG_ID],
      )
    ).map((r) => r.id);
    const stagingIdSet = new Set(stagingIds);

    const overlapIds = stagingIds.length
      ? (
          await q<{ id: string }>(
            orig,
            `SELECT id::text FROM return_items
             WHERE organization_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])
             ORDER BY created_at DESC NULLS LAST`,
            [ORG_ID, stagingIds],
          )
        ).map((r) => r.id)
      : [];
    manifest.copied_overlap_return_item_count = overlapIds.length;

    const idList = [...new Set([...KNOWN_IDS, ...overlapIds.slice(0, 100)])];
    if (!idList.length) {
      throw new Error("No return_item IDs to analyze");
    }

    const perRowOriginal = await q(
      orig,
      `
      SELECT
        ri.id::text,
        ri.status,
        ri.package_id::text,
        ri.pallet_id::text,
        ri.expected_item_id::text,
        ri.resolved_product_id::text,
        ri.resolved_catalog_product_id::text,
        ri.conditions,
        ri.created_at::text,
        ri.deleted_at::text,
        pkg.status AS package_status,
        (ri.package_id IS NOT NULL
          AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
        ) AS is_physical_anchor,
        (ri.conditions && $1::text[]) AS has_claimable_condition,
        EXISTS (
          SELECT 1 FROM claim_lines cl2
          WHERE cl2.organization_id = ri.organization_id
            AND cl2.return_item_id = ri.id
            AND cl2.line_grain = 'return_item'
            AND cl2.claim_case_id IS NOT NULL
        ) AS has_claim_case_via_line,
        EXISTS (
          SELECT 1 FROM claim_submissions cs
          WHERE cs.organization_id = ri.organization_id AND cs.return_id = ri.id
        ) AS has_claim_submission,
        (SELECT count(*)::int FROM claim_candidates c
         WHERE c.organization_id = ri.organization_id
           AND c.source_table = 'return_items'
           AND c.source_row_id = ri.id) AS claim_candidate_count,
        (SELECT count(*)::int FROM claim_lines cl
         WHERE cl.organization_id = ri.organization_id
           AND cl.return_item_id = ri.id
           AND cl.line_grain = 'return_item') AS return_item_claim_lines
      FROM return_items ri
      LEFT JOIN packages pkg ON pkg.id = ri.package_id
      WHERE ri.id = ANY($2::uuid[])
      ORDER BY ri.created_at DESC NULLS LAST
      `,
      [claimableArr, idList],
    );

    const perRowStaging = await q(
      stag,
      `
      SELECT
        ri.id::text,
        ri.status,
        ri.package_id::text,
        ri.pallet_id::text,
        ri.expected_item_id::text,
        ri.resolved_product_id::text,
        ri.resolved_catalog_product_id::text,
        ri.conditions,
        ri.created_at::text,
        (ri.package_id IS NOT NULL
          AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
        ) AS is_physical_anchor,
        (ri.conditions && $2::text[]) AS has_claimable_condition,
        EXISTS (
          SELECT 1 FROM claim_lines cl2
          WHERE cl2.organization_id = ri.organization_id
            AND cl2.return_item_id = ri.id
            AND cl2.line_grain = 'return_item'
            AND cl2.claim_case_id IS NOT NULL
        ) AS has_claim_case_via_line,
        (SELECT count(*)::int FROM claim_candidates c
         WHERE c.organization_id = ri.organization_id
           AND c.source_table = 'return_items'
           AND c.source_row_id = ri.id) AS claim_candidate_count
      FROM return_items ri
      WHERE ri.id = ANY($1::uuid[])
      `,
      [idList, claimableArr],
    );

    const stagById = new Map(perRowStaging.map((r) => [r.id, r]));
    const rowAnalysis = perRowOriginal.map((o) => {
      const s = stagById.get(o.id as string);
      const blockers: string[] = [];
      if (o.deleted_at) blockers.push("deleted");
      if (!o.is_physical_anchor) blockers.push("not_physical_anchor");
      if (!o.has_claimable_condition) blockers.push("no_claimable_condition");
      if (!o.resolved_product_id && !o.resolved_catalog_product_id) blockers.push("no_resolved_product");
      if (o.package_status && !["closed", "submitted"].includes(String(o.package_status).toLowerCase())) {
        blockers.push("package_not_closed");
      }
      if (Number(o.claim_candidate_count) === 0) blockers.push("no_claim_candidate");
      return { original: o, staging: s ?? null, ui_blockers: blockers };
    });
    manifest.per_row_analysis = rowAnalysis;

    const draftPoolSim = await q(
      orig,
      `
      SELECT count(*)::int AS draft_pool_rows
      FROM return_items ri
      LEFT JOIN packages pkg ON pkg.id = ri.package_id
      WHERE ${physicalSql}
      `,
      [ORG_ID, claimableArr],
    );
    manifest.original_draft_pool_simulated_count = draftPoolSim[0]?.draft_pool_rows ?? 0;

    const policyRaw = (orgSettings[0] as { claim_policy?: unknown } | undefined)?.claim_policy;
    manifest.claim_policy_from_org = policyRaw ?? null;

    const claimCasesCols = await q(
      orig,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='claim_cases' ORDER BY ordinal_position`,
    );
    manifest.original_claim_cases_columns = claimCasesCols.map((r) => r.column_name);
    manifest.returns_first_claim_cases_schema =
      claimCasesCols.some((r) => r.column_name === "primary_return_item_id");

    const stagClaimCasesCols = await q(
      stag,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='claim_cases' ORDER BY ordinal_position`,
    );
    manifest.staging_claim_cases_has_primary_return_item = stagClaimCasesCols.some(
      (r) => r.column_name === "primary_return_item_id",
    );

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "SUMMARY.md"),
      [
        "# FIX_ORIGINAL_PHYSICAL_RETURN_CLAIM_DRAFTS audit",
        "",
        `Run: \`${rid}\``,
        "",
        "## Original counts",
        "```json",
        JSON.stringify(manifest.original_counts, null, 2),
        "```",
        "",
        `## Draft pool simulated (physical anchor + claimable conditions): **${manifest.original_draft_pool_simulated_count}**`,
        "",
        `## Staging/original overlap return_item IDs: **${manifest.copied_overlap_return_item_count}**`,
        "",
        "## Per-row (known + overlap sample)",
        "```json",
        JSON.stringify(rowAnalysis.slice(0, 30), null, 2),
        "```",
      ].join("\n"),
    );

    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await orig.end();
    await stag.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
