/**
 * NEXT-CLAIM-19 — Read-only smoke: Claim Inbox schema resolution + projection scan + optional HTTP.
 *
 *   npx tsx scripts/claim-inbox-api-smoke.ts
 *   npx tsx scripts/claim-inbox-api-smoke.ts --org-id=<uuid>
 *   CLAIM_INBOX_SMOKE_BASE_URL=http://localhost:3000 CLAIM_INBOX_SMOKE_COOKIE="..." npx tsx scripts/claim-inbox-api-smoke.ts
 *
 * Writes under `.cursor/audit-reports/next-claim-19/<runId>/` (no DB writes).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { InboxQueue } from "../lib/claim-inbox-projection";
import { claimInboxStr, projectClaimCandidatesBatch } from "../lib/claim-inbox-projection";
import {
  getClaimInboxDetailSelect,
  getClaimInboxListSelect,
  getClaimInboxProductBadgeSelect,
  lastClaimCandidateDetailExtraOmitted,
  lastClaimCandidateListOmitted,
  lastProductBadgeOmitted,
  resetClaimInboxSchemaCacheForTests,
} from "../lib/claim-inbox-schema";

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const PAGE = 200;
const MAX_SCAN = 12_000;

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

function isoRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
}

function parseArgs(argv: string[]): { orgId: string } {
  let orgId = DEFAULT_ORG;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || orgId;
  }
  return { orgId };
}

type Nd = Record<string, unknown>;

function appendNd(logPath: string, row: Nd): void {
  fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf8");
}

async function fetchJson(url: string, cookie: string | null): Promise<{ status: number; body: unknown; err?: string }> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { headers, cache: "no-store" });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* raw */
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, err: e instanceof Error ? e.message : String(e) };
  }
}

async function pickCandidatesByQueue(
  client: SupabaseClient,
  organizationId: string,
  listSelect: string,
  logPath: string,
): Promise<Partial<Record<InboxQueue, string>>> {
  const found: Partial<Record<InboxQueue, string>> = {};
  const want = new Set<InboxQueue>([
    "ready_for_review",
    "legacy_source_broken",
    "evidence_missing",
    "needs_product_link",
    "pim_blocked",
  ]);
  let from = 0;
  let read = 0;
  while (want.size > 0 && read < MAX_SCAN) {
    const { data, error } = await client
      .from("claim_candidates")
      .select(listSelect)
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    appendNd(logPath, { phase: "page_fetch", from, error: error?.message ?? null, batch: (data ?? []).length });
    if (error) break;
    const batch = ((data ?? []) as unknown) as unknown as Record<string, unknown>[];
    if (batch.length === 0) break;
    read += batch.length;
    const proj = await projectClaimCandidatesBatch(client, batch, organizationId);
    for (const row of batch) {
      const id = claimInboxStr(row.id);
      if (!id) continue;
      const p = proj.get(id);
      const q = p?.inbox_queue;
      if (q && want.has(q) && !found[q]) {
        found[q] = id;
        want.delete(q);
        appendNd(logPath, { phase: "found_queue", queue: q, claim_candidate_id: id });
      }
    }
    from += PAGE;
    if (batch.length < PAGE) break;
  }
  return found;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId } = parseArgs(process.argv.slice(2));
  const runId = isoRunId();
  const outDir = path.join(".cursor", "audit-reports", "next-claim-19", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "inbox-api-smoke.ndjson");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exitCode = 1;
    return;
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  resetClaimInboxSchemaCacheForTests();

  const listSelect = await getClaimInboxListSelect(client);
  const detailSelect = await getClaimInboxDetailSelect(client);
  const productBadgeSelect = await getClaimInboxProductBadgeSelect(client);

  appendNd(logPath, {
    phase: "schema_resolved",
    list_select: listSelect,
    detail_select: detailSelect,
    product_badge_select: productBadgeSelect,
    omitted_list: lastClaimCandidateListOmitted,
    omitted_detail_extra: lastClaimCandidateDetailExtraOmitted,
    omitted_product: lastProductBadgeOmitted,
  });

  const byQueue = await pickCandidatesByQueue(client, orgId, listSelect, logPath);
  const testIds = [...new Set(Object.values(byQueue).filter(Boolean))] as string[];
  if (testIds.length === 0) {
    const { data: one } = await client.from("claim_candidates").select("id").eq("organization_id", orgId).limit(1);
    const row0 = (one ?? [])[0] as unknown as Record<string, unknown> | undefined;
    const fallback = row0 ? claimInboxStr(row0.id) : null;
    if (fallback) testIds.push(fallback);
  }

  const baseUrl = (process.env.CLAIM_INBOX_SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const cookie = process.env.CLAIM_INBOX_SMOKE_COOKIE?.trim() || null;

  const listSamples: Nd[] = [];
  const listUrls = [
    `${baseUrl}/api/claims/inbox?organization_id=${encodeURIComponent(orgId)}&pageSize=20`,
    `${baseUrl}/api/claims/inbox?organization_id=${encodeURIComponent(orgId)}&pageSize=5&queue=ready_for_review`,
    `${baseUrl}/api/claims/inbox?organization_id=${encodeURIComponent(orgId)}&pageSize=5&queue=legacy_source_broken`,
    `${baseUrl}/api/claims/inbox?organization_id=${encodeURIComponent(orgId)}&pageSize=5&queue=evidence_missing`,
    `${baseUrl}/api/claims/inbox?organization_id=${encodeURIComponent(orgId)}&pageSize=5&queue=needs_product_link`,
    `${baseUrl}/api/claims/inbox?organization_id=${encodeURIComponent(orgId)}&pageSize=5&queue=pim_blocked`,
  ];
  for (const u of listUrls) {
    const r = await fetchJson(u, cookie);
    listSamples.push({ url: u, status: r.status, err: r.err ?? null, body_preview: summarizeBody(r.body) });
    appendNd(logPath, { phase: "http_list", url: u, status: r.status, err: r.err ?? null });
  }

  const detailSamples: Nd[] = [];
  const evidenceSamples: Nd[] = [];
  for (const cid of testIds.slice(0, 5)) {
    const du = `${baseUrl}/api/claims/inbox/${cid}?organization_id=${encodeURIComponent(orgId)}`;
    const dr = await fetchJson(du, cookie);
    detailSamples.push({
      candidate_id: cid,
      url: du,
      status: dr.status,
      err: dr.err ?? null,
      body_preview: summarizeBody(dr.body),
    });
    appendNd(logPath, { phase: "http_detail", candidate_id: cid, status: dr.status });

    const eu = `${baseUrl}/api/claims/inbox/${cid}/evidence?organization_id=${encodeURIComponent(orgId)}`;
    const er = await fetchJson(eu, cookie);
    evidenceSamples.push({
      candidate_id: cid,
      url: eu,
      status: er.status,
      err: er.err ?? null,
      body_preview: summarizeBody(er.body),
    });
    appendNd(logPath, { phase: "http_evidence", candidate_id: cid, status: er.status });
  }

  fs.writeFileSync(path.join(outDir, "list-endpoint-samples.json"), JSON.stringify(listSamples, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "detail-endpoint-samples.json"), JSON.stringify(detailSamples, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "evidence-endpoint-samples.json"), JSON.stringify(evidenceSamples, null, 2), "utf8");

  const schemaMd = [
    "# Schema compatibility (NEXT-CLAIM-19)",
    "",
    "## Resolved `claim_candidates` list select",
    "",
    "```",
    listSelect,
    "```",
    "",
    "## Omitted optional columns",
    "",
    "- List optional omitted: " + (lastClaimCandidateListOmitted.length ? lastClaimCandidateListOmitted.join(", ") : "(none)"),
    "- Detail-extra omitted: " +
      (lastClaimCandidateDetailExtraOmitted.length ? lastClaimCandidateDetailExtraOmitted.join(", ") : "(none)"),
    "- Product badge optional omitted: " + (lastProductBadgeOmitted.length ? lastProductBadgeOmitted.join(", ") : "(none)"),
    "",
    "## `products` badge select",
    "",
    "```",
    productBadgeSelect,
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "schema-compatibility-notes.md"), schemaMd, "utf8");

  const allSamples = [...listSamples, ...detailSamples, ...evidenceSamples];
  const http401 = allSamples.length > 0 && allSamples.every((s) => Number(s.status) === 401);
  const httpHtmlLogin = allSamples.some(
    (s) =>
      Number(s.status) === 200 &&
      s.body_preview &&
      typeof s.body_preview === "object" &&
      (s.body_preview as { kind?: string }).kind === "html_response",
  );
  const httpConnFail = listSamples.some((s) => s.err && String(s.err).toLowerCase().includes("fetch"));

  const summaryMd = [
    "# Claim Inbox API smoke summary (NEXT-CLAIM-19)",
    "",
    `- **Run id:** ${runId}`,
    `- **Organization probed:** \`${orgId}\``,
    `- **Output directory:** \`${outDir.replace(/\\/g, "/")}\``,
    "",
    "## Schema resolution (direct Supabase)",
    "",
    "- List/detail/product badge selects were resolved via **read-only column probes** (see `schema-compatibility-notes.md`).",
    "",
    "## Projection scan (direct Supabase, no HTTP auth)",
    "",
    "First matching `claim_candidate_id` per queue (within scan cap):",
    "",
    ...Object.entries(byQueue).map(([q, id]) => `- **${q}:** \`${id}\``),
    "",
    testIds.length === 0 ? "_No candidates found for org in scan._" : "",
    "",
    "## HTTP smoke",
    "",
    `- **Base URL:** \`${baseUrl}\``,
    `- **Cookie:** ${cookie ? "set (CLAIM_INBOX_SMOKE_COOKIE)" : "not set"}`,
    "",
    httpConnFail
      ? "_HTTP requests failed to connect (dev server likely not running on that base URL). Direct Supabase smoke still ran._"
      : http401 && !cookie
        ? "_All HTTP samples returned **401 Not signed in** without `CLAIM_INBOX_SMOKE_COOKIE` — expected (routes use session cookies)._"
        : httpHtmlLogin && !cookie
          ? "_HTTP returned **200 with HTML** (login page) — middleware redirected unauthenticated API calls. Use a signed-in session cookie (`CLAIM_INBOX_SMOKE_COOKIE`) or test from the browser. Direct Supabase + projection smoke below is authoritative for schema._"
          : "_See JSON samples for status codes._",
    "",
    "## Recommendation",
    "",
    http401 && !cookie
      ? "**1. Proceed to minimal Claim Inbox UI plan** (browser session provides cookies), or set `CLAIM_INBOX_SMOKE_COOKIE` for curl-level HTTP verification."
      : httpHtmlLogin && !cookie
        ? "**1. Proceed to minimal Claim Inbox UI plan** — HTTP smoke needs session; schema/projection validated via Supabase in this run."
        : "**2. Add small backend fixes before UI** only if samples show 5xx or schema errors.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "inbox-api-smoke-summary.md"), summaryMd, "utf8");

  console.log(JSON.stringify({ ok: true, outDir, orgId, byQueue, testIds, listSelect }, null, 2));
}

function summarizeBody(body: unknown): unknown {
  if (typeof body === "string") {
    if (body.includes("<!DOCTYPE") || body.includes("<html")) {
      return {
        kind: "html_response",
        note: "Likely auth middleware redirect to login — not JSON API payload.",
        snippet: body.slice(0, 240),
      };
    }
    if (body.length > 2000) return { raw_string_len: body.length, preview: body.slice(0, 500) };
    return body;
  }
  if (!body || typeof body !== "object") return body;
  const o = body as unknown as Record<string, unknown>;
  if ("error" in o) return { error: o.error };
  if ("items" in o && Array.isArray(o.items)) {
    return {
      item_count: o.items.length,
      next_cursor: o.next_cursor ?? null,
      sample_queues: (o.items as unknown as Record<string, unknown>[]).slice(0, 5).map((r) => ({
        id: r.id,
        inbox_queue: r.inbox_queue,
        lineage_warning_code: r.lineage_warning_code,
        automation_allowed: r.automation_allowed,
      })),
    };
  }
  if ("candidate" in o) {
    return {
      has_candidate: !!o.candidate,
      projection_inbox_queue: (o.projection as unknown as Record<string, unknown> | undefined)?.inbox_queue,
      lineage_warning: o.lineage_warning ?? null,
      product_badges_count: Array.isArray(o.product_badges) ? o.product_badges.length : 0,
    };
  }
  if ("operational_source_row" in o || "slip_contents" in o) {
    return {
      has_operational: o.operational_source_row != null,
      slip_rows: Array.isArray(o.slip_contents) ? o.slip_contents.length : 0,
      claim_submissions: Array.isArray(o.claim_submissions) ? o.claim_submissions.length : 0,
    };
  }
  const keys = Object.keys(o).slice(0, 20);
  try {
    const s = JSON.stringify(o);
    if (s.length > 6000) return { keys, _truncated: true, json_len: s.length, preview: s.slice(0, 2000) };
  } catch {
    /* ignore */
  }
  return { keys };
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
