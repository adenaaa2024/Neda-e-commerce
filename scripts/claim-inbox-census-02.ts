/**
 * CLAIM-INBOX-AUDIT-02 — Read-only claim_candidates census + source pointer / evidence / product heuristics.
 *
 *   npx tsx scripts/claim-inbox-census-02.ts
 *   npx tsx scripts/claim-inbox-census-02.ts --org-id=<uuid>
 *
 * Writes: .cursor/audit-reports/claim-inbox-audit-02/<run_id>/
 * No DB writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchSourceRowsByIds, projectClaimCandidatesBatch } from "../lib/claim-inbox-projection";
import { CLAIM_SUPPORTED_SOURCE_TABLES } from "../lib/claim-operational-source-resolve";
import { mkRunDir, mkRunId, writeCsv } from "../lib/audits/product-seed-output";

const PAGE = 800;
const PROJ_CHUNK = 48;
const CSV_CAP = 4000;

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\n/)) {
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

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function ageBucket(iso: string | null): string {
  if (!iso) return "unknown_age";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown_age";
  const days = (Date.now() - t) / (86400 * 1000);
  if (days <= 30) return "0_30d";
  if (days <= 90) return "31_90d";
  if (days <= 365) return "91_365d";
  return "365p_d";
}

type Cand = Record<string, unknown>;

async function fetchAllCandidates(
  sb: SupabaseClient,
  orgFilter: string | null,
  trace: (m: string) => void,
): Promise<Cand[]> {
  const select =
    "id, organization_id, store_id, source_table, source_row_id, evidence_status, candidate_status, claim_family, claim_reason, product_id, resolved_product_id, sku, asin, fnsku, created_at";
  const out: Cand[] = [];
  let from = 0;
  for (;;) {
    let q = sb.from("claim_candidates").select(select).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (orgFilter) q = q.eq("organization_id", orgFilter);
    const { data, error } = await q;
    if (error) {
      trace(`claim_candidates select error: ${error.message} — retry minimal columns`);
      const minimal =
        "id, organization_id, store_id, source_table, source_row_id, evidence_status, sku, asin, fnsku, created_at";
      let q2 = sb.from("claim_candidates").select(minimal).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (orgFilter) q2 = q2.eq("organization_id", orgFilter);
      const r2 = await q2;
      if (r2.error) throw r2.error;
      out.push(...((r2.data ?? []) as Cand[]));
      if ((r2.data ?? []).length < PAGE) break;
      from += PAGE;
      continue;
    }
    const batch = (data ?? []) as Cand[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function prefetchStrictSourceExistence(
  sb: SupabaseClient,
  byOrg: Map<string, Cand[]>,
  trace: (m: string) => void,
): Promise<Map<string, boolean>> {
  const keySet = new Map<string, boolean>();
  for (const [org, rows] of byOrg) {
    if (org === "(null)" || org.length !== 36) continue;
    const byTable = new Map<string, Set<string>>();
    for (const c of rows) {
      const st = n(c.source_table)?.toLowerCase() ?? "";
      const sid = n(c.source_row_id);
      if (!st || !sid) continue;
      if (!CLAIM_SUPPORTED_SOURCE_TABLES.has(st)) continue;
      if (!byTable.has(st)) byTable.set(st, new Set());
      byTable.get(st)!.add(sid);
    }
    for (const [tbl, idSet] of byTable) {
      const ids = [...idSet];
      for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200);
        const { map, error } = await fetchSourceRowsByIds(sb, tbl, slice, org);
        if (error) {
          trace(`fetchSourceRowsByIds ${tbl}: ${error}`);
          continue;
        }
        for (const sid of slice) {
          const row = map.get(sid);
          const k = `${org}|${tbl}|${sid}`;
          if (!row) {
            keySet.set(k, false);
            continue;
          }
          const rowOrg = n(row.organization_id);
          keySet.set(k, rowOrg === org);
        }
      }
    }
  }
  return keySet;
}

function parseArgs(argv: string[]): { orgId: string | null } {
  for (const a of argv) {
    if (a.startsWith("--org-id=")) return { orgId: a.slice("--org-id=".length).trim() || null };
    if (a.startsWith("--organization-id=")) return { orgId: a.slice("--organization-id=".length).trim() || null };
  }
  return { orgId: null };
}

function bumpHistogram(m: Map<string, number>, k: string, nadd = 1): void {
  m.set(k, (m.get(k) ?? 0) + nadd);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const sb = createServiceClient();
  const { orgId } = parseArgs(process.argv.slice(2));
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "claim-inbox-audit-02"), runId);
  const logNd = path.join(outDir, "logs", "claim-inbox-census.ndjson");
  fs.mkdirSync(path.dirname(logNd), { recursive: true });
  const trace = (msg: string) => {
    fs.appendFileSync(logNd, JSON.stringify({ ts: new Date().toISOString(), msg }) + "\n", "utf8");
  };

  trace("start");
  const { count: totalHead, error: headErr } = await sb
    .from("claim_candidates")
    .select("id", { count: "exact", head: true });
  if (headErr) trace(`head_count_error: ${headErr.message}`);
  const totalReported = totalHead ?? null;

  const rows = await fetchAllCandidates(sb, orgId, trace);
  trace(`fetched_rows=${rows.length} org_filter=${orgId ?? "(none)"}`);

  const byOrg = new Map<string, Cand[]>();
  for (const c of rows) {
    const o = n(c.organization_id) ?? "(null)";
    if (!byOrg.has(o)) byOrg.set(o, []);
    byOrg.get(o)!.push(c);
  }

  const strictOk = await prefetchStrictSourceExistence(sb, byOrg, trace);

  const bySourceTable = new Map<string, number>();
  const byStore = new Map<string, number>();
  const byOrgCount = new Map<string, number>();
  const byAge = new Map<string, number>();
  const byClaimFamily = new Map<string, number>();
  const byCandidateStatus = new Map<string, number>();
  const byEvidenceStatus = new Map<string, number>();

  for (const c of rows) {
    const org = n(c.organization_id) ?? "(null)";
    const stRaw = n(c.source_table);
    const created = n(c.created_at);
    bumpHistogram(bySourceTable, stRaw ?? "(null)");
    bumpHistogram(byStore, n(c.store_id) ?? "(null)");
    bumpHistogram(byOrgCount, org);
    bumpHistogram(byAge, ageBucket(created));
    bumpHistogram(byClaimFamily, n(c.claim_family) ?? "(null)");
    bumpHistogram(byCandidateStatus, n(c.candidate_status) ?? "(null)");
    bumpHistogram(byEvidenceStatus, n(c.evidence_status) ?? "(null)");
  }

  let unsupportedTable = 0;
  let nullPointer = 0;
  let strictMissing = 0;
  let legacyInbox = 0;
  let evidenceMissingQueue = 0;
  let readyReviewQueue = 0;
  let needsProductQueue = 0;
  let pimBlockedQueue = 0;

  let productResolved = 0;
  let rawIdentifierOnly = 0;
  let productUnresolved = 0;

  const brokenCsv: Record<string, unknown>[] = [];
  const missingEvCsv: Record<string, unknown>[] = [];
  const unresolvedProdCsv: Record<string, unknown>[] = [];

  let relA = 0,
    relB = 0,
    relC = 0,
    relD = 0,
    relE = 0;

  for (const [org, list] of byOrg) {
    const orgInvalid = org === "(null)" || org.length !== 36;
    if (orgInvalid) {
      relE += list.length;
      for (const c of list) {
        const id = n(c.id);
        if (id && brokenCsv.length < CSV_CAP) {
          brokenCsv.push({
            id,
            reason: "missing_or_invalid_organization_id",
            source_table: n(c.source_table),
            source_row_id: n(c.source_row_id),
          });
        }
      }
      continue;
    }

    for (let i = 0; i < list.length; i += PROJ_CHUNK) {
      const chunk = list.slice(i, i + PROJ_CHUNK);
      const proj = await projectClaimCandidatesBatch(sb, chunk, org);
      for (const c of chunk) {
        const id = n(c.id);
        if (!id) {
          relE++;
          continue;
        }
        const stRaw = n(c.source_table);
        const st = stRaw?.toLowerCase() ?? "";
        const sid = n(c.source_row_id);
        const ev = n(c.evidence_status);
        const rp = n(c.resolved_product_id);
        const pid = n(c.product_id);
        const sku = n(c.sku);
        const asin = n(c.asin);
        const fnsku = n(c.fnsku);
        if (rp || pid) productResolved++;
        else if (sku || asin || fnsku) rawIdentifierOnly++;
        else {
          productUnresolved++;
          if (unresolvedProdCsv.length < CSV_CAP) {
            unresolvedProdCsv.push({
              id,
              organization_id: org,
              store_id: n(c.store_id),
              source_table: stRaw,
              source_row_id: sid,
              evidence_status: ev,
            });
          }
        }

        const p = proj.get(id);
        if (p?.inbox_queue === "legacy_source_broken") legacyInbox++;
        if (p?.inbox_queue === "evidence_missing") evidenceMissingQueue++;
        if (p?.inbox_queue === "ready_for_review") readyReviewQueue++;
        if (p?.inbox_queue === "needs_product_link") needsProductQueue++;
        if (p?.inbox_queue === "pim_blocked") pimBlockedQueue++;

        const strictKey = sid && st ? `${org}|${st}|${sid}` : null;
        const strictHit = strictKey ? strictOk.get(strictKey) : undefined;

        if (!stRaw || !sid) {
          nullPointer++;
          relE++;
          if (brokenCsv.length < CSV_CAP)
            brokenCsv.push({ id, reason: "null_source_pointer", source_table: stRaw, source_row_id: sid });
          continue;
        }
        if (!CLAIM_SUPPORTED_SOURCE_TABLES.has(st)) {
          unsupportedTable++;
          relC++;
          continue;
        }
        if (strictHit !== true) {
          strictMissing++;
          relE++;
          if (brokenCsv.length < CSV_CAP)
            brokenCsv.push({
              id,
              reason: strictHit === false ? "strict_source_missing_or_org_mismatch" : "strict_source_not_prefetched",
              source_table: st,
              source_row_id: sid,
            });
          continue;
        }
        if (p?.inbox_queue === "legacy_source_broken" || p?.lineage_warning_code === "stale_or_wrong_source_row_id") {
          relC++;
          if (brokenCsv.length < CSV_CAP)
            brokenCsv.push({ id, reason: "legacy_or_stale_lineage_projection", source_table: st, source_row_id: sid });
          continue;
        }
        if (p?.inbox_queue === "evidence_missing" || ev === "missing") {
          relB++;
          if (missingEvCsv.length < CSV_CAP) {
            missingEvCsv.push({
              id,
              organization_id: org,
              source_table: st,
              source_row_id: sid,
              inbox_queue: p?.inbox_queue ?? "",
              evidence_status: ev ?? "",
            });
          }
          continue;
        }
        if (p?.inbox_queue === "ready_for_review" && (rp || pid || p?.proposed_resolved_product_id)) {
          relA++;
          continue;
        }
        if (p?.inbox_queue === "ready_for_review") {
          relB++;
          continue;
        }
        if (p?.inbox_queue === "needs_product_link" && !(rp || pid) && !(sku || asin || fnsku)) {
          relE++;
          continue;
        }
        relB++;
      }
    }
  }

  relD = 0;

  const summary = {
    auditPrompt: "CLAIM-INBOX-AUDIT-02",
    runId,
    org_filter: orgId,
    total_head_count_exact: totalReported,
    fetched_row_count: rows.length,
    pointer: {
      unsupported_source_table: unsupportedTable,
      null_source_table_or_row: nullPointer,
      strict_source_missing_or_org_fail: strictMissing,
      legacy_source_broken_inbox_projection: legacyInbox,
    },
    projection_queue_counts: {
      evidence_missing: evidenceMissingQueue,
      ready_for_review: readyReviewQueue,
      needs_product_link: needsProductQueue,
      pim_blocked: pimBlockedQueue,
    },
    product_identity_on_candidate_row: {
      product_resolved: productResolved,
      raw_identifier_only: rawIdentifierOnly,
      product_unresolved: productUnresolved,
    },
    reliability_mutually_exclusive_heuristic: {
      A_reliable_real_source: relA,
      B_real_but_unverified_logic: relB,
      C_legacy_or_unknown_candidate: relC,
      D_synthetic_or_test_candidate: relD,
      E_broken_lineage: relE,
      sum_check: relA + relB + relC + relD + relE,
      note: "D not detectable from DB; 0. C = unsupported source_table. legacy/stale counted in C after strict hit.",
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

  const stLines = [...bySourceTable.entries()].sort((a, b) => b[1] - a[1]);
  const censusMd = [
    `# Candidate census (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `- **Exact total (PostgREST head):** ${totalReported ?? "n/a"}`,
    `- **Rows fetched in this run:** ${rows.length}${orgId ? ` (filtered to organization_id=${orgId})` : ""}`,
    ``,
    `## By source_table`,
    ``,
    ...stLines.map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## By organization_id (top 25)`,
    ``,
    ...[...byOrgCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## By store_id (top 25)`,
    ``,
    ...[...byStore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## By created_at age bucket`,
    ``,
    ...[...byAge.entries()].map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## claim_family (top 20)`,
    ``,
    ...[...byClaimFamily.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## candidate_status`,
    ``,
    ...[...byCandidateStatus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## evidence_status (raw column)`,
    ``,
    ...[...byEvidenceStatus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}:** ${v}`),
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "candidate-census-summary.md"), censusMd, "utf8");

  const ptrMd = [
    `# Source pointer health (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `Supported tables (strict id + org match on operational row): ${[...CLAIM_SUPPORTED_SOURCE_TABLES].join(", ")}`,
    ``,
    `| Check | Count |`,
    `|-------|------:|`,
    `| Unsupported \`source_table\` | ${unsupportedTable} |`,
    `| Null / empty \`source_table\` or \`source_row_id\` | ${nullPointer} |`,
    `| Strict operational row missing or org mismatch | ${strictMissing} |`,
    `| **legacy_source_broken** (Claim Inbox projection, counted per projection row) | ${legacyInbox} |`,
    ``,
    `Strict fetch uses \`fetchSourceRowsByIds\` (org-scoped). Alternate operational resolution (e.g. removals re-link) is **not** a strict hit — UI may still show \`source_found\` via \`resolveClaimCandidateSourcePack\`.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "source-pointer-health.md"), ptrMd, "utf8");

  const evMd = [
    `# Evidence health (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `Uses **Claim Inbox projection** \`inbox_queue\` plus raw \`evidence_status\` where available.`,
    ``,
    `| Signal | Count (projection passes) |`,
    `|--------|--------------------------:|`,
    `| inbox_queue **evidence_missing** | ${evidenceMissingQueue} |`,
    `| inbox_queue **ready_for_review** | ${readyReviewQueue} |`,
    `| inbox_queue **needs_product_link** | ${needsProductQueue} |`,
    `| inbox_queue **pim_blocked** | ${pimBlockedQueue} |`,
    ``,
    `| Derived bucket | Notes |`,
    `|----------------|-------|`,
    `| **has_evidence** (proxy) | \`ready_for_review\` count — projection passed evidence gate for queue routing |`,
    `| **missing_evidence** | \`evidence_missing\` queue or \`evidence_status === "missing"\` (see CSV) |`,
    `| **legacy_broken** | \`legacy_source_broken\` queue (see pointer doc) |`,
    `| **evidence_unknown** | Not separately counted — use \`needs_product_link\` / operator review |`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "evidence-health.md"), evMd, "utf8");

  const prodMd = [
    `# Product identity dependency (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `Counts on \`claim_candidates\` row only (no deep \`returns\` join).`,
    ``,
    `| Class | Count |`,
    `|-------|------:|`,
    `| **product_resolved** (\`product_id\` or \`resolved_product_id\` present) | ${productResolved} |`,
    `| **raw_identifier_only** (SKU/ASIN/FNSKU but no product UUIDs) | ${rawIdentifierOnly} |`,
    `| **product_unresolved** (no UUIDs and no identifiers) | ${productUnresolved} |`,
    ``,
    `**product_conflict_possible** — use \`scripts/claim-product-linkage-evidence-audit.ts\` for identifier-map fan-out.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "product-identity-dependency-counts.md"), prodMd, "utf8");

  const relMd = [
    `# Reliability classification counts (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `Mutually exclusive heuristic (see \`scripts/claim-inbox-census-02.ts\`). **Sum = ${relA + relB + relC + relD + relE}** (fetched rows).`,
    ``,
    `| Class | Count |`,
    `|-------|------:|`,
    `| **A** reliable_real_source | ${relA} |`,
    `| **B** real_but_unverified_logic | ${relB} |`,
    `| **C** legacy_or_unknown_candidate | ${relC} |`,
    `| **D** synthetic_or_test_candidate | ${relD} |`,
    `| **E** broken_lineage | ${relE} |`,
    ``,
    `- **D** = not detectable without tenant policy; **0**.`,
    `- **C** = unsupported \`source_table\` **or** legacy/stale lineage after strict source hit.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "reliability-classification-counts.md"), relMd, "utf8");

  const unsupMd = [
    `# Unsupported source_table values (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `Non-empty tables not in {${[...CLAIM_SUPPORTED_SOURCE_TABLES].join(", ")}}:`,
    ``,
    ...[...bySourceTable.entries()]
      .filter(([k]) => k !== "(null)" && !CLAIM_SUPPORTED_SOURCE_TABLES.has(k.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${k}:** ${v} rows`),
    ...(unsupportedTable === 0 ? ["- *(none among classified unsupported rows — see census for all labels)*"] : []),
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "unsupported-source-tables.md"), unsupMd, "utf8");

  const opMd = [
    `# Operational readiness (CLAIM-INBOX-AUDIT-02)`,
    ``,
    `Claim Inbox is **read-only triage**, not proof of a valid payable claim (CLAIM-INBOX-AUDIT-01). This census sizes pointer, evidence, and identity gaps.`,
    ``,
    `## Can Claim Inbox be trusted operationally?`,
    ``,
    `- **As a faithful view of \`claim_candidates\` + projection:** yes, for triage.`,
    `- **As automation for filing / reimbursement:** no until ingestion is owned and **A**/**B** buckets are improved (see counts in \`manifest.json\`).`,
    ``,
    `## Exact next step`,
    ``,
    `1. Review capped CSVs: \`broken-source-pointers.csv\`, \`missing-evidence-candidates.csv\`, \`unresolved-product-candidates.csv\` (max ${CSV_CAP} rows each).`,
    `2. Remediate **legacy removals** / **strict pointer** failures with operators.`,
    `3. Document the external \`claim_candidates\` writer; re-run this script after ingestion changes.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "operational-readiness-recommendation.md"), opMd, "utf8");

  if (brokenCsv.length) writeCsv(path.join(outDir, "broken-source-pointers.csv"), Object.keys(brokenCsv[0]!), brokenCsv);
  if (missingEvCsv.length) writeCsv(path.join(outDir, "missing-evidence-candidates.csv"), Object.keys(missingEvCsv[0]!), missingEvCsv);
  if (unresolvedProdCsv.length)
    writeCsv(path.join(outDir, "unresolved-product-candidates.csv"), Object.keys(unresolvedProdCsv[0]!), unresolvedProdCsv);

  trace("complete");
  console.log(`[claim-inbox-audit-02] out_dir=${outDir}`);
  console.log(`[claim-inbox-audit-02] fetched=${rows.length} head_total=${totalReported} rel_sum=${relA + relB + relC + relD + relE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
