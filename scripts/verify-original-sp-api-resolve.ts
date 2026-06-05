import { createRequire, type Module } from "node:module";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv } from "../lib/production-db-bind";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
  const res = await resolveReportsApiContext(ORG_ID, STORE_ID);
  console.log(
    JSON.stringify(
      res.ok
        ? {
            ok: true,
            marketplace_ids: res.context.marketplaceIds,
            reports_host: res.context.reportsHost,
            aws_region: res.context.aws.region,
            has_access_token: Boolean(res.context.accessToken),
          }
        : { ok: false, error: res.error },
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
