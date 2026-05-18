/**
 * Static validation for Finances API archive migration + types (ARCHIVE-02).
 * No DB connection, no SP-API.
 *
 * Run: npm run test:finances-api-archive-schema
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  AMAZON_FINANCES_ARCHIVE_TABLES,
  AMAZON_FINANCES_SOURCE_RUN_STATES,
  buildAmazonFinancesEventGroupsLatestSelectColumns,
  isAmazonFinancesSourceRunState,
  parseAmazonFinancesSourceRunRow,
} from "../lib/amazon/finances-api-archive";

const MIGRATION = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260819120000_amazon_finances_api_archive.sql",
);

const FORBIDDEN_DML_IN_MIGRATION = [
  /INSERT\s+INTO\s+public\.financial_reference_resolver/i,
  /UPDATE\s+public\.financial_reference_resolver/i,
  /ALTER\s+TABLE\s+public\.financial_reference_resolver/i,
  /INSERT\s+INTO\s+public\.amazon_settlements/i,
  /INSERT\s+INTO\s+public\.amazon_transactions/i,
  /INSERT\s+INTO\s+public\.reimbursements/i,
  /INSERT\s+INTO\s+public\.amazon_staging/i,
];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main(): void {
  let passed = 0;
  const sql = fs.readFileSync(MIGRATION, "utf8");

  for (const table of AMAZON_FINANCES_ARCHIVE_TABLES) {
    assert(sql.includes(`CREATE TABLE IF NOT EXISTS public.${table}`), `missing CREATE TABLE ${table}`);
    assert(sql.includes(`ENABLE ROW LEVEL SECURITY`), "RLS enable missing");
    passed++;
  }

  assert(sql.includes("v_amazon_finances_event_groups_latest"), "missing latest view");
  assert(sql.includes("amazon_finances_source_runs_org_idempotency_key"), "run idempotency unique");
  assert(sql.includes("amazon_finances_api_pages_run_op_sequence_key"), "page sequence unique");
  assert(sql.includes("uq_amazon_finances_events_org_version_group_type_amazon_id"), "partial event unique");
  passed += 4;

  for (const pattern of FORBIDDEN_DML_IN_MIGRATION) {
    assert(!pattern.test(sql), `forbidden DML: ${pattern}`);
  }
  passed += FORBIDDEN_DML_IN_MIGRATION.length;

  for (const state of AMAZON_FINANCES_SOURCE_RUN_STATES) {
    assert(isAmazonFinancesSourceRunState(state), `state ${state}`);
  }
  passed++;

  const parsed = parseAmazonFinancesSourceRunRow({
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: "00000000-0000-4000-8000-000000000002",
    finances_api_version: "2024-11-20",
    operation: "finances.listFinancialEventGroups",
    idempotency_key: "abc",
    state: "requested",
    attempt: {},
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  assert(parsed?.state === "requested", "parseAmazonFinancesSourceRunRow");
  passed++;

  assert(buildAmazonFinancesEventGroupsLatestSelectColumns().includes("event_group_id"), "select columns");
  passed++;

  console.log(`\n${passed} checks passed.`);
}

main();
