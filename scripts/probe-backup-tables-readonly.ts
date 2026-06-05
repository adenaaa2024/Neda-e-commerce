import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function main() {
  loadEnvLocalIntoProcess();
  const orig = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL!,
    ssl: { rejectUnauthorized: false },
  });
  await orig.connect();
  const tables = await orig.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '_backup_phase_ab%' ORDER BY tablename`,
  );
  console.log("backup tables:", tables.rows);
  await orig.end();
}
main().catch(console.error);
