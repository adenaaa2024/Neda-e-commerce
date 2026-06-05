import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import pg from "pg";

const ORIGINAL = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pgUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!pgUrl.includes(ORIGINAL)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL required");
  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const mp = await c.query(
    `SELECT credentials FROM marketplaces WHERE organization_id=$1::uuid AND provider='amazon_sp_api' LIMIT 1`,
    [ORG_ID],
  );
  const cred = mp.rows[0]?.credentials as Record<string, unknown> | undefined;
  const keys = cred && typeof cred === "object" ? Object.keys(cred).sort() : [];
  const nonempty = keys.filter((k) => String(cred?.[k] ?? "").trim().length > 0);
  await c.end();
  console.log(JSON.stringify({ credential_keys: keys, nonempty_keys: nonempty }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
