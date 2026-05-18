/**
 * NEXT-CLAIM-TRID-02 — Read-only TRID / financial reference candidate extraction for claim drafts.
 *
 *   npx tsx scripts/claim-trid-02-draft-extraction-dryrun.ts --org-id=<uuid>
 *   npx tsx scripts/claim-trid-02-draft-extraction-dryrun.ts --org-id=<uuid> --run-id=myRun
 *   npx tsx scripts/claim-trid-02-draft-extraction-dryrun.ts --org-id=<uuid> --include-returns
 *
 * SELECT only. Writes:
 *   .cursor/audit-reports/next-claim-trid-02/<run_id>/
 *
 * Prerequisite: NEXT-AMAZON-REFERENCE-GRAPH-01 (formerly NEXT-CLAIM-TRID-01) artifact pack; uses financial_reference_resolver
 * as documented in lib/financial-reference-resolver-sync.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { isUuidString } from "../lib/uuid";

const SCRIPT_VERSION = "claim-trid-02-readonly-v1";
const PAGE = 500;
const ORDER_CHUNK = 40;
const FRR_SELECT = "trid_key, source_table, source_row_id, settlement_id, order_id, sku, confidence_score, reference_group_key, transaction_type";

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

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normSku(s: string | null | undefined): string | null {
  const t = nv(s);
  return t ? t.toLowerCase() : null;
}

function isoRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

type DraftRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  sku: string | null;
};

type RemovalRow = { id: string; order_id: string | null; sku: string | null };

type FrrRow = Record<string, unknown>;

function parseArgs(argv: string[]): { orgId: string | null; runId: string | null; includeReturns: boolean } {
  let orgId: string | null = null;
  let runId: string | null = null;
  let includeReturns = false;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a === "--include-returns") includeReturns = true;
  }
  return { orgId, runId, includeReturns };
}

async function probeFrr(client: SupabaseClient, orgId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await client.from("financial_reference_resolver").select("trid_key").eq("organization_id", orgId).limit(1);
  if (error) {
    const m = error.message ?? "";
    if (m.includes("Could not find") || m.includes("does not exist")) return { ok: false, error: m };
    return { ok: false, error: m };
  }
  return { ok: true };
}

async function fetchAllDrafts(client: SupabaseClient, orgId: string, includeReturns: boolean): Promise<DraftRow[]> {
  const tables = includeReturns ? ["amazon_removals", "amazon_returns"] : ["amazon_removals"];
  const out: DraftRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidate_drafts")
      .select("id, organization_id, store_id, source_table, source_row_id, sku")
      .eq("organization_id", orgId)
      .in("source_table", tables)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`claim_candidate_drafts: ${error.message}`);
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of batch) {
      const id = nv(r.id);
      const org = nv(r.organization_id);
      const st = nv(r.source_table);
      const sid = nv(r.source_row_id);
      if (!id || !org || !st || !sid) continue;
      out.push({
        id,
        organization_id: org,
        store_id: nv(r.store_id),
        source_table: st,
        source_row_id: sid,
        sku: nv(r.sku),
      });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function fetchRemovalsByIds(client: SupabaseClient, orgId: string, ids: string[]): Promise<Map<string, RemovalRow>> {
  const map = new Map<string, RemovalRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await client
      .from("amazon_removals")
      .select("id, order_id, sku")
      .eq("organization_id", orgId)
      .in("id", slice);
    if (error) throw new Error(`amazon_removals: ${error.message}`);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = nv(r.id);
      if (!id) continue;
      map.set(id, { id, order_id: nv(r.order_id), sku: nv(r.sku) });
    }
  }
  return map;
}

async function fetchReturnsByIds(client: SupabaseClient, orgId: string, ids: string[]): Promise<Map<string, { id: string; order_id: string | null; sku: string | null }>> {
  const map = new Map<string, { id: string; order_id: string | null; sku: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data, error } = await client
      .from("amazon_returns")
      .select("id, order_id, sku")
      .eq("organization_id", orgId)
      .in("id", slice);
    if (error) {
      /** Returns table may use different column names — skip if probe fails */
      return map;
    }
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = nv(r.id);
      if (!id) continue;
      map.set(id, { id, order_id: nv(r.order_id), sku: nv(r.sku) });
    }
  }
  return map;
}

async function fetchFrrByOrderIds(client: SupabaseClient, orgId: string, orderIds: string[]): Promise<Map<string, FrrRow[]>> {
  const byOrder = new Map<string, FrrRow[]>();
  const unique = [...new Set(orderIds.map((x) => nv(x)).filter(Boolean))] as string[];
  for (let i = 0; i < unique.length; i += ORDER_CHUNK) {
    const chunk = unique.slice(i, i + ORDER_CHUNK);
    const { data, error } = await client
      .from("financial_reference_resolver")
      .select(FRR_SELECT)
      .eq("organization_id", orgId)
      .in("order_id", chunk);
    if (error) throw new Error(`financial_reference_resolver: ${error.message}`);
    for (const row of (data ?? []) as FrrRow[]) {
      const oid = nv(row.order_id);
      if (!oid) continue;
      const arr = byOrder.get(oid) ?? [];
      arr.push(row);
      byOrder.set(oid, arr);
    }
  }
  return byOrder;
}

async function countWorkItemsForDrafts(client: SupabaseClient, orgId: string, draftIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (let i = 0; i < draftIds.length; i += 200) {
    const slice = draftIds.slice(i, i + 200);
    const { data, error } = await client
      .from("claim_review_work_items")
      .select("id, draft_id")
      .eq("organization_id", orgId)
      .in("draft_id", slice);
    if (error) {
      /** Table may be absent in some envs */
      return m;
    }
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const did = nv(r.draft_id);
      const wid = nv(r.id);
      if (did && wid) m.set(did, wid);
    }
  }
  return m;
}

function filterCandidatesBySku(rows: FrrRow[], skuHint: string | null): FrrRow[] {
  const hint = normSku(skuHint);
  if (!hint) return rows;
  const matched = rows.filter((r) => {
    const s = normSku(nv(r.sku));
    return s === hint;
  });
  return matched.length > 0 ? matched : rows;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, runId: runIdArg, includeReturns } = parseArgs(process.argv.slice(2));
  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid>");
    process.exitCode = 1;
    return;
  }

  const runId = runIdArg ?? `claim-trid-02-${isoRunId()}`;
  const outDir = path.resolve(process.cwd(), ".cursor", "audit-reports", "next-claim-trid-02", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const client = createServiceClient();
  const frrProbe = await probeFrr(client, orgId);

  const summary: Record<string, unknown> = {
    prompt_name: "NEXT-CLAIM-TRID-02",
    run_id: runId,
    script_version: SCRIPT_VERSION,
    organization_id: orgId,
    include_returns: includeReturns,
    financial_reference_resolver_available: frrProbe.ok,
    upstream_trid01: ".cursor/audit-reports/next-claim-trid-01/20260515T210000Z-trid-discovery/",
  };

  if (!frrProbe.ok) {
    summary.error = frrProbe.error;
    fs.writeFileSync(path.join(outDir, "00-summary.json"), JSON.stringify(summary, null, 2), "utf8");
    fs.writeFileSync(
      path.join(outDir, "next-step-recommendation.md"),
      `# Blocked\n\n\`financial_reference_resolver\` is not available: ${frrProbe.error}\n\nApply the resolver migration on this project or run against an environment where Phase 4 FRR sync has created the table.\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt_name: "NEXT-CLAIM-TRID-02",
          run_id: runId,
          mode: "read_only_dry_run_blocked",
          validation: { db_writes: false, frr_table_present: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const drafts = await fetchAllDrafts(client, orgId, includeReturns);
  const removalIds = drafts.filter((d) => d.source_table === "amazon_removals").map((d) => d.source_row_id);
  const returnIds = drafts.filter((d) => d.source_table === "amazon_returns").map((d) => d.source_row_id);
  const removalsMap = await fetchRemovalsByIds(client, orgId, removalIds);
  const returnsMap = includeReturns && returnIds.length ? await fetchReturnsByIds(client, orgId, returnIds) : new Map();

  const orderIds: string[] = [];
  for (const d of drafts) {
    if (d.source_table === "amazon_removals") {
      const rm = removalsMap.get(d.source_row_id);
      const oid = rm?.order_id ?? null;
      if (oid) orderIds.push(oid);
    } else if (d.source_table === "amazon_returns") {
      const ret = returnsMap.get(d.source_row_id);
      const oid = ret?.order_id ?? null;
      if (oid) orderIds.push(oid);
    }
  }

  const frrByOrder = await fetchFrrByOrderIds(client, orgId, orderIds);
  const draftIds = drafts.map((d) => d.id);
  const workItemByDraft = await countWorkItemsForDrafts(client, orgId, draftIds);

  let deterministic = 0;
  let ambiguous = 0;
  let missing = 0;
  let noOrderPath = 0;
  let missingOperationalRow = 0;
  const sampleLines: string[] = [];

  const csv = [
    "draft_id,source_table,source_row_id,work_item_id,order_id,sku_hint,frr_all_count,frr_sku_filtered_count,outcome",
  ];

  for (const d of drafts) {
    let orderId: string | null = null;
    let skuHint: string | null = d.sku;
    let opMissing = false;

    if (d.source_table === "amazon_removals") {
      const rm = removalsMap.get(d.source_row_id);
      if (!rm) {
        opMissing = true;
        missingOperationalRow++;
      } else {
        orderId = rm.order_id;
        skuHint = skuHint ?? rm.sku;
      }
    } else if (d.source_table === "amazon_returns") {
      const ret = returnsMap.get(d.source_row_id);
      if (!ret) {
        opMissing = true;
        missingOperationalRow++;
      } else {
        orderId = ret.order_id;
        skuHint = skuHint ?? ret.sku;
      }
    }

    const wid = workItemByDraft.get(d.id) ?? "";

    if (opMissing) {
      csv.push(
        [d.id, d.source_table, d.source_row_id, wid, "", nv(skuHint) ?? "", "", "", "missing_operational_row"].join(","),
      );
      missing++;
      continue;
    }

    if (!orderId) {
      noOrderPath++;
      csv.push([d.id, d.source_table, d.source_row_id, wid, "", nv(skuHint) ?? "", "0", "0", "no_order_id"].join(","));
      missing++;
      continue;
    }

    const all = frrByOrder.get(orderId) ?? [];
    const filtered = filterCandidatesBySku(all, skuHint);
    const useSet = filtered;
    const n = useSet.length;

    let outcome: string;
    if (n === 0) {
      missing++;
      outcome = "missing_frr";
    } else if (n === 1) {
      deterministic++;
      outcome = "deterministic_single";
    } else {
      ambiguous++;
      outcome = "ambiguous_multiple";
    }

    csv.push(
      [
        d.id,
        d.source_table,
        d.source_row_id,
        wid,
        orderId,
        nv(skuHint) ?? "",
        String(all.length),
        String(filtered.length),
        outcome,
      ].join(","),
    );

    if (sampleLines.length < 300) {
      sampleLines.push(
        JSON.stringify({
          draft_id: d.id,
          work_item_id: wid || null,
          source_table: d.source_table,
          source_row_id: d.source_row_id,
          order_id: orderId,
          sku_hint: skuHint,
          frr_count_all_order: all.length,
          frr_count_after_sku_filter: filtered.length,
          outcome,
          sample_trid_keys: useSet.slice(0, 5).map((r) => nv(r.trid_key)),
        }),
      );
    }
  }

  summary.counts = {
    drafts_scanned: drafts.length,
    drafts_with_work_item: [...workItemByDraft.keys()].length,
    trid_outcome_deterministic_single: deterministic,
    trid_outcome_ambiguous_multiple: ambiguous,
    trid_outcome_missing_frr_or_no_order: missing,
    no_order_id_on_operational_row: noOrderPath,
    missing_operational_source_row: missingOperationalRow,
    unique_order_ids_queried: new Set(orderIds).size,
  };

  fs.writeFileSync(path.join(outDir, "00-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "01-draft-trid-candidates.ndjson"), sampleLines.join("\n") + (sampleLines.length ? "\n" : ""), "utf8");
  fs.writeFileSync(path.join(outDir, "02-draft-trid-outcomes.csv"), csv.join("\n") + "\n", "utf8");

  const opReview = `# Operator review needs

From dry-run counts:

- **Deterministic (single FRR row after order + optional SKU filter):** ${deterministic} — lowest review burden if values paste cleanly to Amazon.
- **Ambiguous (multiple FRR rows):** ${ambiguous} — operator must pick correct settlement/transaction line; show all \`trid_key\` + \`settlement_id\` + amounts in UI.
- **Missing / no path:** ${missing} — includes drafts with no \`order_id\` on removal/return row, no FRR rows for order, or missing operational row.
- **Missing operational row:** ${missingOperationalRow} — \`source_row_id\` not found in live table (stale draft pointer).

FRR join rule: \`financial_reference_resolver.organization_id\` + \`order_id\`; optional SKU filter prefers rows where FRR.sku matches draft/removal sku, else falls back to all rows for that order (ambiguous).
`;

  fs.writeFileSync(path.join(outDir, "03-operator-review-needs.md"), opReview, "utf8");

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# NEXT-CLAIM-TRID-03 — TRID UI + PAYLOAD PROJECTION (READ-ONLY DESIGN OR IMPLEMENTATION)

After reviewing \`02-draft-trid-outcomes.csv\`:

1. Add read-only API or server component data loader that returns \`trid_candidates[]\` for a draft/work item (same join as this script).
2. Extend filing handoff \`payload\` contract with optional \`trid_operator_selected\` (no auto-submit).
3. Consider SQL view or materialized helper only if query cost requires it.

Hard constraints until product sign-off: no auto-fill to Amazon; operator confirmation for ambiguous rows.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_name: "NEXT-CLAIM-TRID-02",
        run_id: runId,
        mode: "read_only_dry_run",
        script: "scripts/claim-trid-02-draft-extraction-dryrun.ts",
        script_version: SCRIPT_VERSION,
        organization_id: orgId,
        tables_queried: [
          "financial_reference_resolver",
          "claim_candidate_drafts",
          "amazon_removals",
          "amazon_returns",
          "claim_review_work_items",
        ],
        artifacts: ["00-summary.json", "01-draft-trid-candidates.ndjson", "02-draft-trid-outcomes.csv", "03-operator-review-needs.md", "next-step-recommendation.md", "manifest.json"],
        validation: {
          db_writes: false,
          migrations: false,
          claim_mutations: false,
          filing_mutations: false,
          product_mutations: false,
          amazon_api: false,
          external_api: false,
          ai: false,
          local_artifacts_only: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`NEXT-CLAIM-TRID-02 complete. Output: ${outDir}`);
  console.log(JSON.stringify(summary.counts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
