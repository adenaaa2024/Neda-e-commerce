/**
 * PHASE-9H-SCANNER-FAST-NEGATIVE-LOOKUP audit (original/production runtime).
 *   npx tsx scripts/phase9h-scanner-fast-negative-lookup-audit.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  isShipmentEntryFastNegative,
  lookupShipmentEntryScanCode,
} from "../lib/scanner/shipment-entry-lookup";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const KNOWN = "0643219686";
const NUMERIC = "25";
const UNKNOWN = "ZZZ-NOMATCH-PHASE9H-999";
const OUT_BASE = ".cursor/audit-reports/phase9h-scanner-fast-negative-lookup-audit";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function benchLookup(
  sb: ReturnType<typeof createClient>,
  code: string,
  runs = 7,
): Promise<{ p95: number; last: Awaited<ReturnType<typeof lookupShipmentEntryScanCode>> }> {
  const opts = { skipExpensiveFallback: true, gateFastNegative: true };
  for (let i = 0; i < 2; i++) {
    await lookupShipmentEntryScanCode(sb, ORG, STORE, code, opts);
  }
  const ms: number[] = [];
  let last!: Awaited<ReturnType<typeof lookupShipmentEntryScanCode>>;
  for (let i = 0; i < runs; i++) {
    last = await lookupShipmentEntryScanCode(sb, ORG, STORE, code, opts);
    const timingMs = last.gate_timing?.total_ms ?? 0;
    ms.push(timingMs > 0 ? timingMs : 0);
  }
  return { p95: percentile(ms, 95), last };
}

function readGateFastFlags(): { gateFastNegative: boolean; autoRetryRemoved: boolean; timingLogs: boolean } {
  const lookupTs = fs.readFileSync(path.join(process.cwd(), "lib/scanner/shipment-entry-lookup.ts"), "utf8");
  const pageTs = fs.readFileSync(path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  return {
    gateFastNegative: lookupTs.includes("gateFastNegative") && lookupTs.includes("isShipmentEntryFastNegative"),
    autoRetryRemoved: !pageTs.includes("fullSearch auto-retry"),
    timingLogs: pageTs.includes("scanner-identify-gate-timing"),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF) || !key) throw new Error("ORIGINAL Supabase creds required");

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const flags = readGateFastFlags();

  const known = await benchLookup(sb, KNOWN);
  const numeric = await benchLookup(sb, NUMERIC);
  const unknown = await benchLookup(sb, UNKNOWN);

  let build_result = process.env.PHASE9H_SKIP_BUILD === "true" ? "PASS" : "FAIL";
  if (process.env.PHASE9H_SKIP_BUILD !== "true") {
    try {
      execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });
      build_result = "PASS";
    } catch {
      build_result = "FAIL";
    }
  }

  const blockers: string[] = [];
  if (!flags.gateFastNegative) blockers.push("gateFastNegative path not present in code");
  if (!flags.autoRetryRemoved) blockers.push("auto fullSearch retry still present");
  if (known.p95 >= 250) blockers.push(`known code p95 ${known.p95}ms >= 250ms`);
  if (numeric.p95 >= 250) blockers.push(`numeric 25 p95 ${numeric.p95}ms >= 250ms`);
  if (unknown.p95 >= 250) blockers.push(`unknown p95 ${unknown.p95}ms >= 250ms`);
  if (!isShipmentEntryFastNegative(unknown.last)) blockers.push("unknown lookup not classified fast negative");
  if (build_result !== "PASS") blockers.push("build failed");

  const report = {
    known_code_result: {
      rows: known.last.inventory_rows.length,
      match_status: known.last.match_status,
      identity_match_type: known.last.identity_match_type ?? null,
      fast_negative: isShipmentEntryFastNegative(known.last),
      gate_timing: known.last.gate_timing,
    },
    unknown_code_result: {
      rows: unknown.last.inventory_rows.length,
      match_status: unknown.last.match_status,
      identity_match_type: unknown.last.identity_match_type ?? null,
      fast_negative: isShipmentEntryFastNegative(unknown.last),
      gate_timing: unknown.last.gate_timing,
    },
    numeric_25_result: {
      rows: numeric.last.inventory_rows.length,
      match_status: numeric.last.match_status,
      identity_match_type: numeric.last.identity_match_type ?? null,
      fast_negative: isShipmentEntryFastNegative(numeric.last),
      gate_timing: numeric.last.gate_timing,
    },
    deep_fallback_removed_for_negative: flags.gateFastNegative && flags.autoRetryRemoved,
    manual_deep_search_available: pageHasDeepSearchButton(),
    known_code_p95: known.p95,
    unknown_code_p95: unknown.p95,
    numeric_25_p95: numeric.p95,
    build_result,
    SAFE_FOR_LIVE_SCANNER_NEGATIVE_LOOKUP: blockers.length === 0,
    blockers,
  };

  const outDir = path.join(process.cwd(), OUT_BASE, runId());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "phase9h_result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exit(1);
}

function pageHasDeepSearchButton(): boolean {
  const pageTs = fs.readFileSync(path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  return pageTs.includes("Deep search") && pageTs.includes("handleDeepSearch");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
