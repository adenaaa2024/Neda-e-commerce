/**
 * FIX_ORIGINAL_PHYSICAL_RETURN_CLAIM_DRAFTS — apply returns-first claim_policy on original only.
 *
 *   npx tsx scripts/fix-original-physical-return-claim-policy-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { normalizeClaimPolicy } from "../lib/claim-eligibility-policy";
import { isClaimModuleDomainEnabled } from "../lib/claim-module-scope";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/fix-original-physical-return-claim-policy-execute";

const TARGET_POLICY = {
  schema_version: 1,
  scan_go_live_date: "2026-01-15",
  claim_start_date: "2026-01-15",
  claim_eligibility_window_days: 90,
  claim_grouping_policy: "single_item",
  claim_hold_policy: ["hold_until_package_closed"],
  enabled_claim_domains: {
    returns: true,
    warehouse_inventory: false,
    carrier_shipments: false,
    removals: false,
    financial: false,
    expected_group: false,
    marketplace: false,
  },
} as const;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase();
  if (ref !== ORIGINAL_REF) throw new Error(`Must target original ${ORIGINAL_REF}`);

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const before = await client.query(
    `SELECT claim_policy FROM organization_settings WHERE organization_id = $1::uuid`,
    [ORG_ID],
  );
  const beforePolicy = before.rows[0]?.claim_policy ?? null;

  let afterPolicy = beforePolicy;
  if (apply) {
    const res = await client.query(
      `UPDATE organization_settings
       SET claim_policy = $2::jsonb
       WHERE organization_id = $1::uuid
       RETURNING claim_policy`,
      [ORG_ID, JSON.stringify(TARGET_POLICY)],
    );
    afterPolicy = res.rows[0]?.claim_policy ?? TARGET_POLICY;
  }

  const normalized = normalizeClaimPolicy(afterPolicy);
  const returnsEnabled = isClaimModuleDomainEnabled(normalized, "returns");

  const draftPool = await client.query(
    `SELECT count(*)::int AS n
     FROM return_items ri
     WHERE ri.deleted_at IS NULL
       AND ri.organization_id = $1::uuid
       AND ri.package_id IS NOT NULL
       AND NOT (
         ri.expected_item_id IS NOT NULL
         AND ri.package_id IS NULL
         AND ri.pallet_id IS NULL
       )
       AND ri.conditions && ARRAY[
         'damaged_product','scratched','wrong_item','wrong_item_different','wrong_item_junk',
         'expired','missing_parts','missing_item','empty_box','damaged_box',
         'damaged_warehouse','damaged_customer','damaged_carrier','wet','counterfeit_suspect','operator_other'
       ]::text[]`,
    [ORG_ID],
  );

  const manifest = {
    run_id: rid,
    apply,
    target_ref: ORIGINAL_REF,
    organization_id: ORG_ID,
    claim_policy_before: beforePolicy,
    claim_policy_after: apply ? afterPolicy : beforePolicy,
    returns_domain_enabled_after: returnsEnabled,
    draft_pool_physical_claimable_count: draftPool.rows[0]?.n ?? 0,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
