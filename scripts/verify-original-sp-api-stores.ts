import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import pg from "pg";

const ORIGINAL = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function keySummary(cred: unknown): string[] {
  if (!cred || typeof cred !== "object" || Array.isArray(cred)) return [];
  return Object.keys(cred as Record<string, unknown>)
    .filter((k) => String((cred as Record<string, unknown>)[k] ?? "").trim().length > 0)
    .sort();
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pgUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const store = await c.query(
    `SELECT s.id, s.platform, m.provider, m.credentials
     FROM stores s
     LEFT JOIN marketplaces m ON m.id = s.marketplace_id
     WHERE s.id=$1::uuid AND s.organization_id=$2::uuid`,
    [STORE_ID, ORG_ID],
  );
  const allMp = await c.query(
    `SELECT id, provider, credentials FROM marketplaces WHERE organization_id=$1::uuid`,
    [ORG_ID],
  );
  await c.end();
  console.log(
    JSON.stringify(
      {
        store: store.rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          provider: r.provider,
          credential_keys: keySummary(r.credentials),
        })),
        marketplaces: allMp.rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          credential_keys: keySummary(r.credentials),
        })),
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
