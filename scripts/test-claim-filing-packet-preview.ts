/**
 * CLAIM-EVIDENCE-09 — Unit tests for packet preview helpers (no DB).
 */

import { CLAIM_FILING_PACKET_PREVIEW_SCHEMA_VERSION } from "../lib/claim-filing-packet-preview";
import { packetSourceLabel } from "../lib/claim-filing-packet-preview";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testSchemaVersion(): void {
  assert(
    CLAIM_FILING_PACKET_PREVIEW_SCHEMA_VERSION === "claim-filing-packet-preview-v1",
    "schema version",
  );
}

function testSourceLabel(): void {
  assert(packetSourceLabel("amazon_removals") === "Amazon removals", "removals label");
  assert(packetSourceLabel("unknown_table") === "unknown_table", "fallback");
}

async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ["schema version", testSchemaVersion],
    ["source label", testSourceLabel],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
