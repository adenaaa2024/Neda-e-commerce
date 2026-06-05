/** Check SP-API credential completeness on original DB only — safe output. */
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import pg from "pg";

const ORIGINAL = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pgUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!pgUrl.includes(ORIGINAL)) {
    console.log(JSON.stringify({ ok: false, error: "ORIGINAL_DIRECT_POSTGRES_URL not set for original" }));
    process.exit(1);
  }
  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const mp = await c.query(
    `SELECT id, provider, credentials FROM marketplaces WHERE organization_id=$1::uuid AND provider='amazon_sp_api' LIMIT 1`,
    [ORG_ID],
  );
  const oak = await c.query(
    `SELECT name FROM organization_api_keys WHERE organization_id=$1::uuid AND name='amazon_sp_api' LIMIT 1`,
    [ORG_ID],
  );
  const cred = mp.rows[0]?.credentials as Record<string, unknown> | undefined;
  const lwa = Boolean(
    cred &&
      String(cred.lwa_client_id ?? cred.lwaClientId ?? "").trim() &&
      String(cred.lwa_client_secret ?? cred.lwaClientSecret ?? "").trim() &&
      String(cred.refresh_token ?? cred.refreshToken ?? "").trim(),
  );
  const aws = Boolean(
    cred &&
      String(cred.aws_access_key ?? cred.aws_access_key_id ?? "").trim() &&
      String(cred.aws_secret_key ?? cred.aws_secret_access_key ?? "").trim(),
  );
  await c.end();
  console.log(
    JSON.stringify({
      target_ref: ORIGINAL,
      marketplaces_row: mp.rowCount > 0,
      organization_api_keys_row: oak.rowCount > 0,
      lwa_complete: lwa,
      aws_in_db: aws,
      sp_api_ready: lwa && aws,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
