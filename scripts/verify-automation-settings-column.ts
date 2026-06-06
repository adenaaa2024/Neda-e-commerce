import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

loadEnvLocalIntoProcess();

async function hasColumn(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'platform_settings'
       AND column_name = 'automation_settings'
     LIMIT 1`,
  );
  await client.end();
  return (result.rowCount ?? 0) > 0;
}

const staging = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
const original = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();

if (!staging || !original) {
  console.error("Missing STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL");
  process.exit(1);
}

async function main() {
  console.log(
    JSON.stringify({
      staging: await hasColumn(staging!),
      original: await hasColumn(original!),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
