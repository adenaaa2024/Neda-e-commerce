/**
 * Read-only staging verify: pilot org claim_policy.enabled_claim_domains.
 *
 *   npx tsx scripts/claim-module-scope-phase1-staging-verify.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { normalizeClaimPolicy } from "../lib/claim-eligibility-policy";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PILOT_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-module-scope-phase1-implement",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  if (ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ claim_policy: unknown }>(
      `SELECT claim_policy FROM organization_settings WHERE organization_id = $1`,
      [PILOT_ORG_ID],
    );
    const normalized = normalizeClaimPolicy(rows[0]?.claim_policy ?? {});
    const manifest = {
      run_id: rid,
      staging_ref: STAGING_REF,
      pilot_organization_id: PILOT_ORG_ID,
      enabled_claim_domains: normalized.enabled_claim_domains,
      returns_enabled: normalized.enabled_claim_domains.returns === true,
      marketplace_enabled: normalized.enabled_claim_domains.marketplace === true,
    };
    fs.writeFileSync(path.join(outDir, "staging-pilot-policy.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "SUMMARY.md"),
      [
        "# Staging verify — claim module scope",
        "",
        `Pilot org returns enabled: **${manifest.returns_enabled}**`,
        `Marketplace enabled: **${manifest.marketplace_enabled}**`,
      ].join("\n") + "\n",
    );
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
