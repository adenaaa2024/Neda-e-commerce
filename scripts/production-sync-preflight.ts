import { createRequire, type Module } from "node:module";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { PRODUCTION_REF, bindProductionSupabaseEnv, productionPostgresUrl } from "../lib/production-db-bind";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function jwtRef(token: string): string | null {
  try {
    const p = token.split(".")[1];
    if (!p) return null;
    return (JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { ref?: string }).ref ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const bind = bindProductionSupabaseEnv();
  const pgUrl = productionPostgresUrl();
  const keyRef = jwtRef(process.env.ORIGINAL_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

  const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
  const sp = await resolveReportsApiContext(ORG_ID, STORE_ID);

  const ok =
    bind.ref === PRODUCTION_REF &&
    pgUrl.includes(PRODUCTION_REF) &&
    keyRef === PRODUCTION_REF &&
    sp.ok;

  console.log(
    JSON.stringify(
      {
        target_confirmed: bind.ref === PRODUCTION_REF,
        target_ref: bind.ref,
        ORIGINAL_DIRECT_POSTGRES_URL_resolves_original: pgUrl.includes(PRODUCTION_REF),
        SUPABASE_SERVICE_ROLE_KEY_jwt_ref: keyRef,
        service_role_matches_original: keyRef === PRODUCTION_REF,
        amazon_credentials_found: sp.ok,
        amazon_error: sp.ok ? null : sp.error,
        preflight_pass: ok,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
