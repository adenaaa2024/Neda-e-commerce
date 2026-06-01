/**
 * CLAIM-CUTOFF-POLICY-CONFIGURE-STAGING — staging-only claim_policy JSON for pilot org.
 *
 *   npx tsx scripts/claim-cutoff-policy-configure-staging.ts --apply [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  evaluateClaimEligibilitySync,
  evaluateImportCandidateCutoffSync,
  normalizeClaimPolicy,
} from "../lib/claim-eligibility-policy";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/phase1-latest-stash-land";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-cutoff-policy-configure-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/claim-cutoff-policy-configure-staging";

/** Staging pilot org (scanner smoke + ops tenant). */
const PILOT_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const PILOT_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";

const SCAN_GO_LIVE = "2026-01-15";
const CLAIM_START = "2026-01-15";

const CLAIM_POLICY_JSON = {
  schema_version: 1,
  scan_go_live_date: SCAN_GO_LIVE,
  claim_start_date: CLAIM_START,
  claim_eligibility_window_days: 90,
  claim_grouping_policy: "single_item",
  claim_hold_policy: ["hold_until_package_closed"],
  enabled_claim_domains: {
    returns: true,
    warehouse_inventory: false,
    carrier_shipments: false,
    removals: false,
    financial: false,
    expected_mismatch: false,
    marketplace: false,
  },
} as const;

const ROLLBACK_SQL = `-- Rollback: pilot org claim_policy only (staging)
UPDATE public.organization_settings
SET claim_policy = '{}'::jsonb
WHERE organization_id = '${PILOT_ORG_ID}';
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { valid: boolean; flags: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const configure = /APPROVED_CLAIM_CUTOFF_POLICY_CONFIGURE_STAGING\s*=\s*true/i.test(text);
  const targetRef = text.match(/TARGET_SUPABASE_REF\s*=\s*([a-z]{20})/i)?.[1]?.toLowerCase();
  const refOk = !targetRef || targetRef === STAGING_REF;
  return {
    valid: staging && configure && refOk,
    flags: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_CLAIM_CUTOFF_POLICY_CONFIGURE_STAGING: configure ? "true" : "false",
      TARGET_SUPABASE_REF: targetRef ?? "(not set)",
      TARGET_REF_MATCHES_STAGING: refOk ? "true" : "false",
    },
  };
}

function refFromConnectionUrl(url: string): string | null {
  return refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
}

type OrgRow = {
  organization_id: string;
  company_display_name: string | null;
  claim_policy: unknown;
  store_count: number;
  return_item_count: number;
  min_return_item_at: string | null;
  max_return_item_at: string | null;
};

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
  if (!approval.valid) blockers.push("Approval flags not satisfied — STOP");
  if (autoPromote) blockers.push("CLAIM_SCANNER_AUTO_PROMOTE_ENABLED must stay off for this task");

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromConnectionUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (ref === ORIGINAL_REF) blockers.push(`BLOCKED: connection targets original ${ORIGINAL_REF}`);

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      ...Object.entries(approval.flags).map(([k, v]) => `- ${k}: **${v}**`),
      "",
      `- CLAIM_SCANNER_AUTO_PROMOTE_ENABLED: **${autoPromote ? "ON (blocked)" : "off"}**`,
      `- Branch: \`${branch}\``,
      `- Pilot org: \`${PILOT_ORG_ID}\``,
      `- Pilot store: \`${PILOT_STORE_ID}\``,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "rollback.sql"), ROLLBACK_SQL);
  fs.writeFileSync(
    path.join(outDir, "claim-policy-target.json"),
    JSON.stringify(CLAIM_POLICY_JSON, null, 2) + "\n",
  );

  const client = new pg.Client({ connectionString: dbUrl });

  try {
    if (!blockers.length) await client.connect();

    const orgCensus = blockers.length
      ? []
      : (
          await client.query<OrgRow>(
            `SELECT os.organization_id,
                    os.company_display_name,
                    os.claim_policy,
                    (SELECT COUNT(*)::int FROM stores s WHERE s.organization_id = os.organization_id) AS store_count,
                    (SELECT COUNT(*)::int FROM return_items ri WHERE ri.organization_id = os.organization_id) AS return_item_count,
                    (SELECT MIN(ri.created_at)::text FROM return_items ri WHERE ri.organization_id = os.organization_id) AS min_return_item_at,
                    (SELECT MAX(ri.created_at)::text FROM return_items ri WHERE ri.organization_id = os.organization_id) AS max_return_item_at
             FROM organization_settings os
             ORDER BY os.organization_id`,
          )
        ).rows;

    fs.writeFileSync(path.join(outDir, "org-census.json"), JSON.stringify(orgCensus, null, 2) + "\n");

    const pilot = orgCensus.find((o) => o.organization_id === PILOT_ORG_ID);
    if (!blockers.length && !pilot) {
      blockers.push(`Pilot org ${PILOT_ORG_ID} missing from organization_settings`);
    }

    const storeOk = blockers.length
      ? null
      : (
          await client.query<{ id: string }>(
            `SELECT id FROM stores WHERE id = $1 AND organization_id = $2 LIMIT 1`,
            [PILOT_STORE_ID, PILOT_ORG_ID],
          )
        ).rows[0];

    if (!blockers.length && !storeOk) {
      blockers.push(`Pilot store ${PILOT_STORE_ID} not found for org ${PILOT_ORG_ID}`);
    }

    let applied = false;
    let beforePolicy: unknown = pilot?.claim_policy ?? null;
    let afterPolicy: unknown = null;

    if (!blockers.length && apply) {
      const upd = await client.query(
        `UPDATE organization_settings
         SET claim_policy = $2::jsonb
         WHERE organization_id = $1
         RETURNING organization_id, claim_policy`,
        [PILOT_ORG_ID, JSON.stringify(CLAIM_POLICY_JSON)],
      );
      if (upd.rowCount !== 1) {
        blockers.push("UPDATE claim_policy did not affect exactly one pilot row");
      } else {
        applied = true;
        afterPolicy = upd.rows[0]?.claim_policy;
      }
    }

    const configured = normalizeClaimPolicy(applied ? afterPolicy : CLAIM_POLICY_JSON);

    const eligibilityChecks = [
      {
        name: "pre_cutoff_scanner_blocked",
        pass: !evaluateClaimEligibilitySync({
          policy: configured,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-01-10",
          hasScannerEvidence: true,
          evaluationDate: "2026-05-18",
          packageClosed: true,
        }).allowed,
        detail: "Scanner event before scan_go_live_date must be blocked",
      },
      {
        name: "post_cutoff_scanner_with_evidence_allowed",
        pass: evaluateClaimEligibilitySync({
          policy: configured,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-05-10",
          hasScannerEvidence: true,
          evaluationDate: "2026-05-18",
          packageClosed: true,
        }).allowed,
        detail: "Scanner event on/after go-live with evidence, closed package, within 90-day window",
      },
      {
        name: "import_pre_cutoff_blocked",
        pass: !evaluateImportCandidateCutoffSync(
          configured,
          "amazon_returns",
          { return_date: "2025-12-01", created_at: "2025-12-01" },
          null,
          "2026-05-18",
        ).allowed,
        detail: "Historical import before claim_start_date blocked",
      },
      {
        name: "import_post_cutoff_passes_date_gate_only",
        pass: evaluateImportCandidateCutoffSync(
          configured,
          "amazon_returns",
          { return_date: "2026-05-01", created_at: "2026-05-01" },
          null,
          "2026-05-18",
        ).allowed,
        detail:
          "Post claim_start_date imports pass date gate within window; module scope + promote still gate creation",
      },
      {
        name: "settings_normalize_matches_dates",
        pass:
          configured.scan_go_live_date === SCAN_GO_LIVE &&
          configured.claim_start_date === CLAIM_START &&
          configured.claim_eligibility_window_days === 90 &&
          configured.claim_grouping_policy === "single_item" &&
          configured.claim_hold_policy.includes("hold_until_package_closed"),
        detail: "normalizeClaimPolicy (Settings read path) reflects configured dates/holds",
      },
      {
        name: "other_orgs_untouched_empty",
        pass: orgCensus
          .filter((o) => o.organization_id !== PILOT_ORG_ID)
          .every((o) => {
            const p = o.claim_policy;
            return p == null || (typeof p === "object" && Object.keys(p as object).length === 0);
          }),
        detail: "Non-pilot org claim_policy remains {}",
      },
    ];

    const allPolicies = blockers.length
      ? []
      : (
          await client.query(
            `SELECT organization_id,
                    claim_policy->>'scan_go_live_date' AS scan_go_live_date,
                    claim_policy->>'claim_start_date' AS claim_start_date,
                    claim_policy
             FROM organization_settings
             ORDER BY organization_id`,
          )
        ).rows;

    const pilotDomains = blockers.length
      ? null
      : (
          await client.query<{ domains: unknown }>(
            `SELECT claim_policy->'enabled_claim_domains' AS domains
             FROM organization_settings WHERE organization_id = $1`,
            [PILOT_ORG_ID],
          )
        ).rows[0]?.domains;

    const checksPass = eligibilityChecks.every((c) => c.pass);
    if (!checksPass && !blockers.length) {
      blockers.push("One or more eligibility verification checks failed");
    }
    const status = blockers.length
      ? "BLOCKED"
      : apply && applied && checksPass
        ? "PASS"
        : apply
          ? "FAIL"
          : "DRY_RUN";
    const manifest = {
      run_id: runId,
      status,
      staging_ref: STAGING_REF,
      branch,
      pilot_organization_id: PILOT_ORG_ID,
      pilot_store_id: PILOT_STORE_ID,
      applied,
      auto_promote_enabled: autoPromote,
      policy_dates: { scan_go_live_date: SCAN_GO_LIVE, claim_start_date: CLAIM_START },
      enabled_claim_domains_note:
        "Stored in JSON for phase-2 module scope; ClaimPolicyV1 type does not read domains yet.",
      eligibility_checks: eligibilityChecks,
      pilot_enabled_claim_domains: pilotDomains,
      blockers,
    };

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(
      path.join(outDir, "SUMMARY.md"),
      [
        "# CLAIM-CUTOFF-POLICY-CONFIGURE-STAGING",
        "",
        `**Status:** ${status}`,
        `**Run ID:** ${runId}`,
        `**Staging ref:** ${STAGING_REF}`,
        "",
        "## Target",
        "",
        `| Field | Value |`,
        `|-------|-------|`,
        `| organization_id | \`${PILOT_ORG_ID}\` |`,
        `| store_id | \`${PILOT_STORE_ID}\` |`,
        `| company_display_name | ${pilot?.company_display_name ?? "(unknown)"} |`,
        `| return_items | ${pilot?.return_item_count ?? "—"} (${pilot?.min_return_item_at ?? "—"} … ${pilot?.max_return_item_at ?? "—"}) |`,
        "",
        "## Policy written",
        "",
        "```json",
        JSON.stringify(CLAIM_POLICY_JSON, null, 2),
        "```",
        "",
        "## Verification",
        "",
        ...eligibilityChecks.map(
          (c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`,
        ),
        "",
        "## Settings UI",
        "",
        "- Read path: `getOrganizationClaimPolicy` → `normalizeClaimPolicy(claim_policy)` in `organization-claim-policy-actions.ts`",
        "- Claim Engine tab loads policy via `getOrganizationClaimPolicy(tenantCtx)` in `app/settings/page.tsx`",
        "",
        "## Guards",
        "",
        `- Auto-promote env: **${autoPromote ? "ON (should not be)" : "off"}**`,
        `- No claim_lines / claim_cases created by this script`,
        "",
        "## All org policies",
        "",
        "```json",
        JSON.stringify(allPolicies, null, 2),
        "```",
        "",
        ...(blockers.length
          ? ["## Blockers", "", ...blockers.map((b) => `- ${b}`)]
          : !apply
            ? ["## Next step", "", "`npx tsx scripts/claim-cutoff-policy-configure-staging.ts --apply`"]
            : []),
      ].join("\n") + "\n",
    );

    if (blockers.length) {
      fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    }

    console.log(JSON.stringify({ runId, outDir, status, applied, blockers }, null, 2));
    if (blockers.length || status !== "PASS") process.exit(1);
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
