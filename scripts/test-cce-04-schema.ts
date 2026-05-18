/**
 * NEXT-CONTINUOUS-CLAIM-ENRICHMENT-04 — Schema / RLS probe (SELECT + catalog checks only).
 *
 *   npx tsx scripts/test-cce-04-schema.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

const TABLES = [
  "claim_enrichment_generations",
  "claim_evidence_lineage_events",
  "claim_reference_edges",
  "claim_enrichment_freeze_state",
] as const;

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");

  const host = new URL(url).hostname;
  const client = createClient(url, key, { auth: { persistSession: false } });

  const results: Record<string, { present: boolean; error: string | null; row_count?: number }> = {};
  for (const table of TABLES) {
    const pkCol = table === "claim_enrichment_freeze_state" ? "draft_id" : "id";
    const { data, error } = await client.from(table).select(pkCol).limit(1);
    if (error) {
      const msg = error.message ?? "";
      const missing =
        msg.includes("Could not find") ||
        msg.includes("does not exist") ||
        msg.includes("schema cache") ||
        error.code === "42P01";
      results[table] = { present: false, error: msg };
    } else {
      const { count } = await client.from(table).select(pkCol, { count: "exact", head: true });
      results[table] = { present: true, error: null, row_count: count ?? data?.length ?? 0 };
    }
  }

  const allPresent = TABLES.every((t) => results[t].present);
  console.log(
    JSON.stringify(
      {
        project_host: host,
        all_present: allPresent,
        tables: results,
        enrichment_diff_configured: allPresent,
      },
      null,
      2,
    ),
  );
  process.exitCode = allPresent ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
