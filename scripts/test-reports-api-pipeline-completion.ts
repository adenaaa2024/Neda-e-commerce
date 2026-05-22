/**
 * Unit tests for Reports API pipeline completion assessment.
 * Run: npm run test:reports-api-pipeline-completion
 */

import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const { resolvePipelineEntryState } = await import("../lib/amazon/reports-api-pipeline-completion");

  type C = import("../lib/amazon/reports-api-pipeline-completion").ReportsApiPipelineCompletion;

  function base(over: Partial<C>): C {
    return {
      upload_id: "u1",
      organization_id: "o1",
      kind: "SETTLEMENT",
      upload_status: "staged",
      domain_table: "amazon_settlements",
      staging_rows: 100,
      domain_rows: 0,
      domain_complete: false,
      needs_domain_sync: true,
      ...over,
    };
  }

  const a = base({});
  assert(resolvePipelineEntryState("complete", a) === "syncing", "complete + staged → syncing");
  assert(resolvePipelineEntryState("generic", a) === "syncing", "generic + staged → syncing");

  const b = base({
    staging_rows: 0,
    domain_rows: 100,
    needs_domain_sync: false,
    domain_complete: true,
  });
  assert(resolvePipelineEntryState("complete", b) === "complete", "already synced");

  console.log("2/2 reports-api-pipeline-completion tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
