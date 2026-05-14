/**
 * NEXT-18O — Import NEXT-18M dispute candidates into `pim_identifier_dispute` + initial
 * `pim_conflict_review_event` (`detected`).
 *
 * Defaults to **dry-run** (no writes). Requires explicit `--execute` for inserts.
 * Uses **service role** Supabase client only.
 *
 * Input:
 *   .cursor/audit-reports/next-18m/<runId>/01-dispute-candidates.ndjson
 *   manifest.json in same dir (optional) for source_run_id
 *
 * Dry-run (default):
 *   npx tsx scripts/import-next-18m-disputes.ts
 *
 * Execute later (operator):
 *   npx tsx scripts/import-next-18m-disputes.ts --execute
 *
 * Optional:
 *   --input-dir=<path>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { isUuidString } from "../lib/uuid";

const DEFAULT_INPUT_DIR = path.join(
  ".cursor",
  "audit-reports",
  "next-18m",
  "20260512T020013Z",
);

const TAXONOMY = new Set(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]);
const SHARDS = new Set(["A", "B"]);
const DISPUTE_STATUS = new Set(["open", "claimed", "decided", "committed", "dismissed", "reverted"]);
const DETECTED_BY_KIND = new Set(["operator", "automation", "ai_assist", "pipeline_retry"]);
const EXPECTED_LINES_MIN = 1300;
const EXPECTED_LINES_MAX = 1350;

type DisputeNdjsonRow = Record<string, unknown>;

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (e.g. in .env.local).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseArgs(argv: string[]): { execute: boolean; inputDir: string } {
  let execute = false;
  let inputDir = DEFAULT_INPUT_DIR;
  for (const a of argv) {
    if (a === "--execute") execute = true;
    else if (a.startsWith("--input-dir=")) inputDir = a.slice("--input-dir=".length).trim() || inputDir;
  }
  return { execute, inputDir };
}

function isClassifierFingerprint(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return String(v);
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x));
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

type ParseResult =
  | { ok: true; row: DisputeNdjsonRow; fingerprint: string }
  | { ok: false; line: number; error: string };

function parseLine(line: string, lineNo: number): ParseResult {
  const t = line.trim();
  if (!t) return { ok: false, line: lineNo, error: "empty line" };
  let obj: DisputeNdjsonRow;
  try {
    obj = JSON.parse(t) as DisputeNdjsonRow;
  } catch {
    return { ok: false, line: lineNo, error: "invalid JSON" };
  }
  const rawId = asString(obj.dispute_id)?.trim() ?? "";
  const fp = rawId.toLowerCase();
  if (!isClassifierFingerprint(fp)) {
    return { ok: false, line: lineNo, error: `dispute_id not 32 lowercase hex: ${rawId.slice(0, 20)}` };
  }
  return { ok: true, row: obj, fingerprint: fp };
}

type ValidateResult =
  | { ok: true; fingerprint: string; orgId: string; storeId: string; members: string[] }
  | { ok: false; fingerprint: string; line: number; error: string };

function validateRecord(
  row: DisputeNdjsonRow,
  fingerprint: string,
  lineNo: number,
): ValidateResult {
  const orgId = asString(row.organization_id)?.trim() ?? "";
  const storeId = asString(row.store_id)?.trim() ?? "";
  if (!isUuidString(orgId)) {
    return { ok: false, fingerprint, line: lineNo, error: "invalid organization_id" };
  }
  if (!isUuidString(storeId)) {
    return { ok: false, fingerprint, line: lineNo, error: "invalid store_id" };
  }
  const shard = asString(row.shard)?.trim() ?? "";
  if (!SHARDS.has(shard)) {
    return { ok: false, fingerprint, line: lineNo, error: `invalid shard: ${shard}` };
  }
  const tax = asString(row.taxonomy_cell)?.trim() ?? "";
  if (!TAXONOMY.has(tax)) {
    return { ok: false, fingerprint, line: lineNo, error: `invalid taxonomy_cell: ${tax}` };
  }
  const statusRaw = asString(row.status)?.trim() || "open";
  if (!DISPUTE_STATUS.has(statusRaw)) {
    return { ok: false, fingerprint, line: lineNo, error: `invalid status: ${statusRaw}` };
  }
  const hot = asBool(row.hot_loser_flag);
  if (hot === null) {
    return { ok: false, fingerprint, line: lineNo, error: "missing hot_loser_flag" };
  }
  const revH = asNumber(row.reversibility_window_h);
  if (revH === null || revH < 1) {
    return { ok: false, fingerprint, line: lineNo, error: "missing or invalid reversibility_window_h" };
  }
  const members = asStringArray(row.members);
  if (!members?.length) {
    return { ok: false, fingerprint, line: lineNo, error: "members must be non-empty array" };
  }
  for (const m of members) {
    if (!isUuidString(m)) {
      return { ok: false, fingerprint, line: lineNo, error: `invalid member uuid: ${m}` };
    }
  }
  const rw = asString(row.recommended_winner_id)?.trim();
  if (rw && !isUuidString(rw)) {
    return { ok: false, fingerprint, line: lineNo, error: "invalid recommended_winner_id" };
  }
  if (rw && !members.includes(rw)) {
    return { ok: false, fingerprint, line: lineNo, error: "recommended_winner_id not in members" };
  }
  const dbKind = asString(row.detected_by_kind)?.trim() ?? "";
  if (!DETECTED_BY_KIND.has(dbKind)) {
    return { ok: false, fingerprint, line: lineNo, error: `invalid detected_by_kind: ${dbKind}` };
  }
  const ai = row.ai_advice;
  if (ai != null && typeof ai === "object" && !Array.isArray(ai)) {
    const adv = (ai as Record<string, unknown>).advisory_only;
    if (adv !== true) {
      return { ok: false, fingerprint, line: lineNo, error: "ai_advice must have advisory_only: true when present" };
    }
  }
  return { ok: true, fingerprint, orgId, storeId, members };
}

function buildClassifierPayload(row: DisputeNdjsonRow): Record<string, unknown> {
  return { ...row } as Record<string, unknown>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { execute, inputDir } = parseArgs(process.argv.slice(2));

  const ndPath = path.join(inputDir, "01-dispute-candidates.ndjson");
  if (!fs.existsSync(ndPath)) {
    console.error(`Input not found: ${ndPath}`);
    process.exit(1);
  }

  const manifestPath = path.join(inputDir, "manifest.json");
  let manifestRunId: string | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { runId?: string };
      manifestRunId = m.runId?.trim() ?? null;
    } catch {
      /* ignore */
    }
  }

  const raw = fs.readFileSync(ndPath, "utf8");
  const lines = raw.split("\n");

  const parsed: { line: number; row: DisputeNdjsonRow; fingerprint: string }[] = [];
  const parseErrors: { line: number; error: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i] ?? "";
    if (!rawLine.trim()) continue;
    const pr = parseLine(rawLine, lineNo);
    if (!pr.ok) parseErrors.push({ line: pr.line, error: pr.error });
    else parsed.push({ line: lineNo, row: pr.row, fingerprint: pr.fingerprint });
  }

  const validated: {
    line: number;
    row: DisputeNdjsonRow;
    fingerprint: string;
    orgId: string;
    storeId: string;
    members: string[];
  }[] = [];
  const invalidStructural: { line: number; fingerprint: string; error: string }[] = [];

  for (const p of parsed) {
    const vr = validateRecord(p.row, p.fingerprint, p.line);
    if (!vr.ok) invalidStructural.push({ line: vr.line, fingerprint: vr.fingerprint, error: vr.error });
    else validated.push({ line: p.line, row: p.row, fingerprint: vr.fingerprint, orgId: vr.orgId, storeId: vr.storeId, members: vr.members });
  }

  const warnings: string[] = [];
  if (parsed.length < EXPECTED_LINES_MIN || parsed.length > EXPECTED_LINES_MAX) {
    warnings.push(
      `input line count ${parsed.length} outside typical band ${EXPECTED_LINES_MIN}–${EXPECTED_LINES_MAX} (expected ~1321)`,
    );
  }

  for (const v of validated) {
    const shard = asString(v.row.shard)?.trim();
    const gid = asString(v.row.group_id)?.trim();
    const oid = asString(v.row.orphan_id)?.trim();
    if (shard === "A" && !gid) warnings.push(`line ${v.line}: shard A with empty group_id`);
    if (shard === "B" && !oid) warnings.push(`line ${v.line}: shard B with empty orphan_id`);
    const mc = asNumber(v.row.member_count);
    if (mc != null && mc !== v.members.length) {
      warnings.push(`line ${v.line}: member_count ${mc} !== members.length ${v.members.length}`);
    }
  }

  let sb: SupabaseClient;
  try {
    sb = createServiceClient();
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }

  const uniqueOrgs = [...new Set(validated.map((v) => v.orgId))];
  const orgFound = new Set<string>();
  const orgMissing = new Set<string>();
  for (const oid of uniqueOrgs) {
    const { data, error } = await sb.from("organizations").select("id").eq("id", oid).maybeSingle();
    if (error || !data) orgMissing.add(oid);
    else orgFound.add(oid);
  }

  const storeKey = (orgId: string, storeId: string) => `${orgId}|${storeId}`;
  const uniqueStorePairs = [...new Set(validated.map((v) => storeKey(v.orgId, v.storeId)))].map((k) => {
    const [organization_id, id] = k.split("|");
    return { organization_id, id };
  });

  const storeFound = new Set<string>();
  const storeMissing: { orgId: string; storeId: string }[] = [];
  for (const { organization_id, id } of uniqueStorePairs) {
    const { data, error } = await sb
      .from("stores")
      .select("id, organization_id")
      .eq("id", id)
      .eq("organization_id", organization_id)
      .maybeSingle();
    if (error || !data) storeMissing.push({ orgId: organization_id, storeId: id });
    else storeFound.add(storeKey(organization_id, id));
  }

  const allMemberIds = [...new Set(validated.flatMap((v) => v.members))];
  const productById = new Map<string, { organization_id: string; store_id: string }>();

  for (const ch of chunk(allMemberIds, 150)) {
    const { data, error } = await sb
      .from("products")
      .select("id, organization_id, store_id")
      .in("id", ch);
    if (error) {
      console.error("products batch error:", error.message);
      process.exit(1);
    }
    for (const r of data ?? []) {
      const row = r as { id: string; organization_id: string; store_id: string };
      productById.set(row.id, { organization_id: row.organization_id, store_id: row.store_id });
    }
  }

  const invalidDb: { line: number; fingerprint: string; error: string }[] = [];
  const productMissing = new Set<string>();

  for (const v of validated) {
    if (orgMissing.has(v.orgId)) {
      invalidDb.push({ line: v.line, fingerprint: v.fingerprint, error: "organization not found in DB" });
      continue;
    }
    if (!storeFound.has(storeKey(v.orgId, v.storeId))) {
      invalidDb.push({ line: v.line, fingerprint: v.fingerprint, error: "store not found or wrong organization_id" });
      continue;
    }
    let scopeFail: string | null = null;
    for (const mid of v.members) {
      const pr = productById.get(mid);
      if (!pr) {
        productMissing.add(mid);
        scopeFail = `product missing: ${mid}`;
        break;
      }
      if (pr.organization_id !== v.orgId || pr.store_id !== v.storeId) {
        scopeFail = `product ${mid} org/store (${pr.organization_id},${pr.store_id}) != dispute (${v.orgId},${v.storeId})`;
        break;
      }
    }
    if (scopeFail) {
      invalidDb.push({ line: v.line, fingerprint: v.fingerprint, error: scopeFail });
    }
  }

  const dbReady = validated.filter(
    (v) => !invalidDb.some((e) => e.line === v.line && e.fingerprint === v.fingerprint),
  );

  const existingByOrgFp = new Map<string, string>();
  for (const orgId of uniqueOrgs) {
    const fpsForOrg = dbReady.filter((v) => v.orgId === orgId).map((v) => v.fingerprint);
    for (const ch of chunk(fpsForOrg, 100)) {
      if (ch.length === 0) continue;
      const { data, error } = await sb
        .from("pim_identifier_dispute")
        .select("id, organization_id, classifier_fingerprint")
        .eq("organization_id", orgId)
        .in("classifier_fingerprint", ch);
      if (error) {
        console.error("pim_identifier_dispute lookup error:", error.message);
        process.exit(1);
      }
      for (const r of data ?? []) {
        const row = r as { id: string; organization_id: string; classifier_fingerprint: string };
        existingByOrgFp.set(`${row.organization_id}|${row.classifier_fingerprint}`, row.id);
      }
    }
  }

  let wouldInsertDetectedEvents = 0;
  const disputeIdsNeedingEventCheck: string[] = [];
  for (const v of dbReady) {
    const k = `${v.orgId}|${v.fingerprint}`;
    const existingId = existingByOrgFp.get(k);
    if (!existingId) {
      wouldInsertDetectedEvents += 1;
    } else {
      disputeIdsNeedingEventCheck.push(existingId);
    }
  }

  const hasDetectedEvent = new Set<string>();
  const uniqueDisputeIdsForEventCheck = [...new Set(disputeIdsNeedingEventCheck)];
  for (const ch of chunk(uniqueDisputeIdsForEventCheck, 80)) {
    if (ch.length === 0) continue;
    const { data, error } = await sb
      .from("pim_conflict_review_event")
      .select("dispute_id")
      .in("dispute_id", ch)
      .eq("event_type", "detected");
    if (error) {
      console.error("pim_conflict_review_event batch error:", error.message);
      process.exit(1);
    }
    const seen = new Set((data ?? []).map((r: { dispute_id: string }) => r.dispute_id));
    for (const id of ch) {
      if (seen.has(id)) hasDetectedEvent.add(id);
    }
  }
  for (const id of uniqueDisputeIdsForEventCheck) {
    if (!hasDetectedEvent.has(id)) wouldInsertDetectedEvents += 1;
  }

  const wouldInsertDisputes = dbReady.filter((v) => !existingByOrgFp.has(`${v.orgId}|${v.fingerprint}`)).length;
  const wouldUpdateExistingDisputes = dbReady.filter((v) => existingByOrgFp.has(`${v.orgId}|${v.fingerprint}`)).length;

  const rwInvalidCount = invalidStructural.filter((i) => i.error.includes("recommended_winner")).length;
  const allInvalid = [...invalidStructural, ...invalidDb];

  const report = {
    mode: execute ? "execute" : "dry-run",
    inputDir: path.resolve(inputDir),
    ndjsonPath: path.resolve(ndPath),
    manifestRunId,
    inputRecordsRead: lines.filter((l) => l.trim().length > 0).length,
    parseErrors: parseErrors.length,
    structurallyValid: validated.length,
    structurallyInvalid: invalidStructural.length,
    dbValidationFailed: invalidDb.length,
    validForImport: dbReady.length,
    invalidTotal: allInvalid.length,
    organizationsFound: orgFound.size,
    organizationsMissingList: [...orgMissing],
    storesFoundPairs: storeFound.size,
    storesMissing: storeMissing,
    productsReferencedDistinct: allMemberIds.length,
    productsFoundInDb: productById.size,
    productsMissingDistinct: productMissing.size,
    recommendedWinnerStructErrors: rwInvalidCount,
    wouldInsertDisputes,
    wouldUpdateExistingDisputes,
    wouldInsertDetectedEvents,
    warnings,
    sampleInvalid: allInvalid.slice(0, 20),
    executeLaterCommand: "npx tsx scripts/import-next-18m-disputes.ts --execute",
  };

  console.log(JSON.stringify(report, null, 2));

  if (!execute) {
    return;
  }

  let executeInsertedDisputes = 0;
  let executeUpdatedDisputes = 0;
  let executeInsertedDetectedEvents = 0;
  let executeSkippedExistingDetectedEvents = 0;

  for (const v of dbReady) {
    const fpKey = `${v.orgId}|${v.fingerprint}`;
    const wasExistingDispute = existingByOrgFp.has(fpKey);

    const sourceRun = manifestRunId ?? asString(v.row.detected_by_run_id)?.trim() ?? "unknown";
    const detectedAt = asString(v.row.detected_at)?.trim() || new Date().toISOString();
    const classifierPayload = buildClassifierPayload(v.row);
    const secondary = asStringArray(v.row.secondary_cells) ?? [];
    const groupId = asString(v.row.group_id)?.trim() || null;
    const orphanRaw = v.row.orphan_id;
    const orphanId =
      orphanRaw == null || orphanRaw === ""
        ? null
        : isUuidString(String(orphanRaw))
          ? String(orphanRaw)
          : null;
    const rw = asString(v.row.recommended_winner_id)?.trim() || null;
    const status = asString(v.row.status)?.trim() || "open";
    const insertRow = {
      organization_id: v.orgId,
      store_id: v.storeId,
      classifier_fingerprint: v.fingerprint,
      shard: asString(v.row.shard)?.trim(),
      group_id: groupId,
      orphan_id: orphanId,
      taxonomy_cell: asString(v.row.taxonomy_cell)?.trim(),
      secondary_taxonomy_cells: secondary,
      members: v.members,
      recommended_winner_id: rw,
      identifier_conflicts: v.row.identifier_conflicts ?? [],
      classifier_payload: classifierPayload,
      ai_advice: v.row.ai_advice ?? null,
      hot_loser_flag: asBool(v.row.hot_loser_flag) ?? false,
      reversibility_window_h: asNumber(v.row.reversibility_window_h) ?? 72,
      status,
      detected_at: detectedAt,
      detected_by_run_id: asString(v.row.detected_by_run_id)?.trim() ?? sourceRun,
      detected_by_kind: asString(v.row.detected_by_kind)?.trim() ?? "automation",
      source_run_id: sourceRun,
      policy_version: asString(v.row.policy_version)?.trim() ?? null,
      ai_advice_shape_version: asString(v.row.ai_advice_shape_version)?.trim() ?? null,
      updated_at: new Date().toISOString(),
    };

    const { data: upserted, error: upErr } = await sb
      .from("pim_identifier_dispute")
      .upsert(insertRow, { onConflict: "organization_id,classifier_fingerprint" })
      .select("id")
      .single();
    if (upErr || !upserted) {
      console.error("upsert failed", v.fingerprint, upErr?.message);
      process.exit(1);
    }
    if (wasExistingDispute) executeUpdatedDisputes += 1;
    else executeInsertedDisputes += 1;
    const disputeId = (upserted as { id: string }).id;

    const { data: existingEv } = await sb
      .from("pim_conflict_review_event")
      .select("id")
      .eq("dispute_id", disputeId)
      .eq("event_type", "detected")
      .maybeSingle();
    if (existingEv) {
      executeSkippedExistingDetectedEvents += 1;
      continue;
    }

    const reasoning = classifierPayload;
    const evidenceSnapshot = {
      members_evidence_snapshots: (v.row as { members_evidence_snapshots?: unknown }).members_evidence_snapshots ?? {},
      taxonomy_cell: insertRow.taxonomy_cell,
      shard: insertRow.shard,
      fingerprint: v.fingerprint,
    };
    const { error: insEvErr } = await sb.from("pim_conflict_review_event").insert({
      organization_id: v.orgId,
      store_id: v.storeId,
      dispute_id: disputeId,
      event_type: "detected",
      actor_id: null,
      triggered_by_kind: "pipeline_retry",
      triggered_by_run_id: sourceRun,
      reasoning: reasoning as never,
      evidence_snapshot: evidenceSnapshot as never,
      inverse_ops: null,
      reversible_until: null,
      occurred_at: detectedAt,
      client_ip: null,
      user_agent: null,
    });
    if (insEvErr) {
      console.error("event insert failed", v.fingerprint, insEvErr.message);
      process.exit(1);
    }
    executeInsertedDetectedEvents += 1;
  }

  const sourceRunFilter = manifestRunId ?? "20260512T020013Z";
  const { count: totalDisputes } = await sb
    .from("pim_identifier_dispute")
    .select("*", { count: "exact", head: true });
  const { count: disputesThisRun } = await sb
    .from("pim_identifier_dispute")
    .select("*", { count: "exact", head: true })
    .eq("source_run_id", sourceRunFilter);
  const { count: totalEvents } = await sb
    .from("pim_conflict_review_event")
    .select("*", { count: "exact", head: true });
  const { count: eventsDetectedThisRun } = await sb
    .from("pim_conflict_review_event")
    .select("*", { count: "exact", head: true })
    .eq("event_type", "detected")
    .eq("triggered_by_run_id", sourceRunFilter);

  const executeReport = {
    ok: true,
    execute: true,
    importedRowsProcessed: dbReady.length,
    insertedDisputes: executeInsertedDisputes,
    updatedExistingDisputes: executeUpdatedDisputes,
    insertedDetectedEvents: executeInsertedDetectedEvents,
    skippedExistingDetectedEvents: executeSkippedExistingDetectedEvents,
    invalidRecords: allInvalid.length,
    warnings,
    finalTableCounts: {
      pim_identifier_dispute_total: totalDisputes ?? null,
      pim_identifier_dispute_source_run_id: sourceRunFilter,
      pim_identifier_dispute_matching_source_run: disputesThisRun ?? null,
      pim_conflict_review_event_total: totalEvents ?? null,
      pim_conflict_review_event_detected_matching_triggered_by_run_id: eventsDetectedThisRun ?? null,
    },
    note: "No writes to products or product_identifier_map; pim_canonical_lifecycle_event untouched.",
  };

  console.log(JSON.stringify(executeReport, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
