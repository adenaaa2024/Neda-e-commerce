import fs from "node:fs";
import path from "node:path";
import pg from "pg";

function loadEnvLocal(): Record<string, string> {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const UPLOAD = "47f68c9a-07fa-4472-81a2-52517db5fa57";

async function main() {
  const env = loadEnvLocal();
  const c = new pg.Client({ connectionString: env.DIRECT_POSTGRES_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const meta = await c.query("select metadata from public.raw_report_uploads where id = $1::uuid", [UPLOAD]);
  const dist = await c.query(
    `select coalesce(identifier_resolution_status::text,'(null)') as s, count(*)::int as n
     from public.amazon_manage_fba_inventory where source_upload_id = $1::uuid group by 1 order by n desc`,
    [UPLOAD],
  );
  const amb = await c.query(
    `select count(*)::int as n from public.amazon_manage_fba_inventory
     where source_upload_id = $1::uuid and identifier_resolution_status = 'ambiguous'`,
    [UPLOAD],
  );
  console.log(JSON.stringify({ metadata_resolver: meta.rows[0]?.metadata, status_dist: dist.rows, ambiguous_rows: amb.rows[0] }, null, 2));
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
