/**
 * NEXT-CLAIM-14 — Read-only: discover organization_id values with claim_candidates volume.
 * SELECT-only. Prints JSON to stdout.
 *
 *   npx tsx scripts/claim14-org-volume-probe.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

const PAGE = 1000;
const MAX_ROWS = 200_000;

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
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

  const client = createClient(url, key, { auth: { persistSession: false } });

  const byOrg = new Map<string, number>();
  const byOrgSource = new Map<string, Map<string, number>>();
  let from = 0;
  let read = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidates")
      .select("organization_id, source_table")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    for (const r of batch as { organization_id?: string | null; source_table?: string | null }[]) {
      const oid = (r.organization_id ?? "").trim() || "(null)";
      byOrg.set(oid, (byOrg.get(oid) ?? 0) + 1);
      const st = (r.source_table ?? "(null)").trim() || "(null)";
      if (!byOrgSource.has(oid)) byOrgSource.set(oid, new Map());
      const m = byOrgSource.get(oid)!;
      m.set(st, (m.get(st) ?? 0) + 1);
    }
    read += batch.length;
    if (batch.length < PAGE) break;
    from += PAGE;
    if (read >= MAX_ROWS) break;
  }

  const topOrgs = [...byOrg.entries()]
    .filter(([k]) => k !== "(null)")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([organization_id, claim_candidates_count]) => {
      const dist = byOrgSource.get(organization_id) ?? new Map();
      const source_table_distribution = [...dist.entries()].sort((a, b) => b[1] - a[1]);
      return { organization_id, claim_candidates_count, source_table_distribution };
    });

  console.log(
    JSON.stringify(
      {
        read_only: true,
        rows_scanned: read,
        truncated_at_cap: read >= MAX_ROWS,
        top_organizations: topOrgs,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
