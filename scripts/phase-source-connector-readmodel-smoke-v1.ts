/**
 * Smoke: source connector read-model (read-only, no DB writes).
 *   npx tsx scripts/phase-source-connector-readmodel-smoke-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT = ".cursor/audit-reports/phase-source-connector-readmodel-smoke-v1";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;
  const { supabaseServer } = await import("../lib/supabase-server");
  const { buildSourceConnectorReadiness } = await import("../lib/claims/connectors/source-connector-readmodel");
  const payload = await buildSourceConnectorReadiness(supabaseServer, ORG, STORE);

  const rid = payload.generated_at.replace(/[:.]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(payload, null, 2));

  const ok =
    payload.read_only === true &&
    payload.no_db_writes === true &&
    payload.source_health.length > 0 &&
    payload.claim_readiness.generators.length > 0;

  console.log(
    JSON.stringify(
      {
        smoke: ok ? "PASS" : "FAIL",
        source_health_count: payload.source_health.length,
        generators: payload.claim_readiness.generators.length,
        trid_edges: payload.trid_readiness.claim_reference_edge_count,
        active_candidates: payload.claim_readiness.active_candidate_count,
        artifact: path.join(outDir, "smoke.json"),
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
