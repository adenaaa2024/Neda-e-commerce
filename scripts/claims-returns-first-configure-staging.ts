/**
 * CLAIMS-RETURNS-FIRST-CONFIGURE-STAGING — staging-only claim_policy for Sam org (returns-first draft testing).
 *
 *   npx tsx scripts/claims-returns-first-configure-staging.ts [--apply] [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  evaluateClaimEligibilitySync,
  normalizeClaimPolicy,
} from "../lib/claim-eligibility-policy";
import { isClaimModuleDomainEnabled } from "../lib/claim-module-scope";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/phase1-latest-stash-land";
const APPROVAL_PATH = ".cursor/operator-approvals/claims-returns-first-configure-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/claims-returns-first-configure-staging";

/** Sam Distribution — staging physical return_items org (phase1 smoke target). */
const TARGET_ORG_ID = "00000000-0000-0000-0000-000000000001";

const SCAN_GO_LIVE = "2026-01-15";
const CLAIM_START = "2026-01-15";
const WINDOW_DAYS = 90;

const CLAIM_POLICY_JSON = {
  schema_version: 1,
  scan_go_live_date: SCAN_GO_LIVE,
  claim_start_date: CLAIM_START,
  claim_eligibility_window_days: WINDOW_DAYS,
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

function refFromConnectionUrl(url: string): string | null {
  return refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
}

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { valid: boolean; missing: string[] } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const missing: string[] = [];
  if (!/APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text)) missing.push("APPROVED_TO_RUN_STAGING");
  if (!/APPROVED_CLAIMS_RETURNS_FIRST_CONFIGURE_STAGING\s*=\s*true/i.test(text)) {
    missing.push("APPROVED_CLAIMS_RETURNS_FIRST_CONFIGURE_STAGING");
  }
  const ref = text.match(/TARGET_SUPABASE_REF\s*=\s*([a-z]{20})/i)?.[1]?.toLowerCase();
  if (ref && ref !== STAGING_REF) missing.push(`TARGET_SUPABASE_REF mismatch (${ref})`);
  if (!/scan_go_live_date[\s\S]*?2026-01-15/i.test(text)) missing.push("scan_go_live_date 2026-01-15 in approval");
  if (!/claim_start_date[\s\S]*?2026-01-15/i.test(text)) missing.push("claim_start_date 2026-01-15 in approval");
  if (!/claim_eligibility_window_days[\s\S]*?\b90\b/i.test(text)) {
    missing.push("claim_eligibility_window_days 90 in approval");
  }
  return { valid: missing.length === 0, missing };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const autoPromote =
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "1" ||
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "true";

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH} (got ${branch})`);
  if (!approval.valid) blockers.push(`Approval incomplete: ${approval.missing.join(", ")}`);
  if (autoPromote) blockers.push("CLAIM_SCANNER_AUTO_PROMOTE_ENABLED must stay off");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref = refFromConnectionUrl(dbUrl);
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (dbUrl && ref !== STAGING_REF) blockers.push(`DB URL ref ${ref ?? "?"} !== ${STAGING_REF}`);
  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`STAGING_PROJECT_REF guard failed (expected ${STAGING_REF})`);
  }
  if (ref === ORIGINAL_REF) blockers.push(`BLOCKED: connection targets original`);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  let beforePolicy: unknown = null;
  let afterPolicy: unknown = null;
  let applied = false;

  try {
    if (!blockers.length) await client.connect();

    const beforeR = blockers.length
      ? null
      : await client.query<{ claim_policy: unknown; company_display_name: string | null }>(
          `SELECT claim_policy, company_display_name FROM organization_settings WHERE organization_id = $1`,
          [TARGET_ORG_ID],
        );

    beforePolicy = beforeR?.rows[0]?.claim_policy ?? null;

    if (!blockers.length && apply) {
      const upd = await client.query(
        `UPDATE organization_settings SET claim_policy = $2::jsonb WHERE organization_id = $1 RETURNING claim_policy`,
        [TARGET_ORG_ID, JSON.stringify(CLAIM_POLICY_JSON)],
      );
      if (upd.rowCount !== 1) blockers.push("UPDATE did not affect exactly one row");
      else {
        applied = true;
        afterPolicy = upd.rows[0]?.claim_policy;
      }
    }

    const configured = normalizeClaimPolicy(applied ? afterPolicy : CLAIM_POLICY_JSON);
    const checks = [
      {
        name: "returns_domain_enabled",
        pass: isClaimModuleDomainEnabled(configured, "returns"),
      },
      {
        name: "pre_cutoff_blocked",
        pass: !evaluateClaimEligibilitySync({
          policy: configured,
          claimSource: "scanner_operator_issue",
          eventAt: "2025-12-01",
          hasScannerEvidence: true,
          evaluationDate: "2026-06-01",
          packageClosed: true,
          moduleDomain: "returns",
        }).allowed,
      },
      {
        name: "post_cutoff_allowed",
        pass: evaluateClaimEligibilitySync({
          policy: configured,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-05-10",
          hasScannerEvidence: true,
          evaluationDate: "2026-06-01",
          packageClosed: true,
          moduleDomain: "returns",
        }).allowed,
      },
      {
        name: "package_hold_when_open",
        pass: !evaluateClaimEligibilitySync({
          policy: configured,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-05-10",
          hasScannerEvidence: true,
          evaluationDate: "2026-06-01",
          packageClosed: false,
          moduleDomain: "returns",
        }).allowed,
      },
      {
        name: "outside_window_blocked",
        pass: !evaluateClaimEligibilitySync({
          policy: configured,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-03-01",
          hasScannerEvidence: true,
          evaluationDate: "2026-06-15",
          packageClosed: true,
          moduleDomain: "returns",
        }).allowed,
      },
    ];

    const status = blockers.length
      ? "BLOCKED"
      : apply && applied && checks.every((c) => c.pass)
        ? "PASS"
        : apply
          ? "FAIL"
          : "DRY_RUN";

    const result = {
      run_id: runId,
      status,
      staging_ref: STAGING_REF,
      organization_id: TARGET_ORG_ID,
      company_display_name: beforeR?.rows[0]?.company_display_name ?? null,
      before_policy: beforePolicy,
      after_policy: applied ? afterPolicy : null,
      target_policy: CLAIM_POLICY_JSON,
      applied,
      auto_promote_enabled: autoPromote,
      policy_dates: {
        scan_go_live_date: SCAN_GO_LIVE,
        claim_start_date: CLAIM_START,
        claim_eligibility_window_days: WINDOW_DAYS,
      },
      checks,
      blockers,
    };

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(
      path.join(outDir, "REPORT.md"),
      [
        "# CLAIMS-RETURNS-FIRST-CONFIGURE-STAGING",
        "",
        `**Status:** ${status}`,
        `**Org:** \`${TARGET_ORG_ID}\` (${beforeR?.rows[0]?.company_display_name ?? "Sam Distribution"})`,
        "",
        "## before_policy",
        "",
        "```json",
        JSON.stringify(beforePolicy ?? {}, null, 2),
        "```",
        "",
        "## after_policy",
        "",
        applied
          ? "```json\n" + JSON.stringify(afterPolicy, null, 2) + "\n```"
          : "_not applied (dry-run)_",
        "",
        "## Operator-approved values",
        "",
        `- scan_go_live_date: **${SCAN_GO_LIVE}**`,
        `- claim_start_date: **${CLAIM_START}**`,
        `- claim_eligibility_window_days: **${WINDOW_DAYS}**`,
        `- enabled_claim_domains.returns: **true**`,
        `- claim_hold_policy: **hold_until_package_closed**`,
        "",
        "## Checks",
        "",
        ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} ${c.name}`),
        "",
        ...(blockers.length ? ["## Blockers", "", ...blockers.map((b) => `- ${b}`)] : []),
      ].join("\n"),
    );

    console.log(JSON.stringify(result, null, 2));
    if (status !== "PASS" && status !== "DRY_RUN") process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
