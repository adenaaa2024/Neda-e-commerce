import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import {
  claimInboxStr,
  fetchCandidateSourceContextMap,
  fetchSourceRowsByIds,
  projectClaimCandidatesBatch,
} from "../../../../../../lib/claim-inbox-projection";
import { getClaimInboxListSelect } from "../../../../../../lib/claim-inbox-schema";
import { resolveClaimCandidateSourcePack, CLAIM_SUPPORTED_SOURCE_TABLES } from "../../../../../../lib/claim-operational-source-resolve";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";
import { RETURN_ITEMS_TABLE, RETURN_LIST_SELECT, PACKAGE_LIST_SELECT, PALLET_LIST_SELECT } from "../../../../../returns/returns-constants";

const SLIP_CONTENTS_SELECT = "id, organization_id, store_id, package_id, sort_index, slip_code";

const HEAVY_ROW_KEYS = new Set(["raw_data", "source_payload", "manifest_data", "photo_evidence"]);

function stripHeavyJson(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (HEAVY_ROW_KEYS.has(k)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      out[k] = s.length > 4000 ? `${s.slice(0, 4000)}…(truncated)` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function truncateJson(value: unknown, max = 14_000): unknown {
  try {
    const s = JSON.stringify(value);
    if (s.length <= max) return value;
    return { truncated: true, preview: s.slice(0, max) + "…" };
  } catch {
    return { truncated: true, preview: String(value).slice(0, max) };
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await ctx.params;
  if (!isUuidString(candidateId)) {
    return NextResponse.json({ error: "Invalid candidate id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const listSelect = await getClaimInboxListSelect(supabaseServer);
  const { data: cand, error: cErr } = await supabaseServer
    .from("claim_candidates")
    .select(listSelect)
    .eq("id", candidateId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
  if (!cand) return NextResponse.json({ error: "Candidate not found." }, { status: 404 });

  const candidate = cand as unknown as Record<string, unknown>;
  const storeId = claimInboxStr(candidate.store_id);
  const st = claimInboxStr(candidate.source_table)?.toLowerCase() ?? "";
  const sid = claimInboxStr(candidate.source_row_id);

  const ctxMap = await fetchCandidateSourceContextMap(supabaseServer, [candidateId]);
  const contextRow = ctxMap.get(candidateId) ?? null;

  const sourceMaps = new Map<string, Map<string, Record<string, unknown>>>();
  if (st && sid && CLAIM_SUPPORTED_SOURCE_TABLES.has(st)) {
    const { map, error } = await fetchSourceRowsByIds(supabaseServer, st, [sid], organizationId);
    if (!error) sourceMaps.set(st, map);
  }
  const pack = await resolveClaimCandidateSourcePack(supabaseServer, candidate, sourceMaps, contextRow);
  const operational_source_row = stripHeavyJson(pack.row);

  const projMap = await projectClaimCandidatesBatch(supabaseServer, [candidate], organizationId);
  const projection = projMap.get(candidateId) ?? null;

  const returnId = await resolveReturnIdForEvidence(organizationId, candidate, pack.row);

  let returns_evidence: Record<string, unknown> | null = null;
  const packages_rows: Record<string, unknown>[] = [];
  const pallets_rows: Record<string, unknown>[] = [];

  if (returnId) {
    const { data: ret } = await supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select(RETURN_LIST_SELECT)
      .eq("organization_id", organizationId)
      .eq("id", returnId)
      .maybeSingle();
    if (ret && typeof ret === "object") {
      const r = ret as unknown as Record<string, unknown>;
      returns_evidence = {
        id: claimInboxStr(r.id),
        conditions: r.conditions ?? null,
        photo_evidence: truncateJson(r.photo_evidence),
        package_id: claimInboxStr(r.package_id),
        pallet_id: claimInboxStr(r.pallet_id),
        store_id: claimInboxStr(r.store_id),
        status: claimInboxStr(r.status),
      };
      const pkgId = claimInboxStr(r.package_id);
      const pltId = claimInboxStr(r.pallet_id);
      if (pkgId) {
        const { data: pkg } = await supabaseServer
          .from("packages")
          .select(PACKAGE_LIST_SELECT)
          .eq("organization_id", organizationId)
          .eq("id", pkgId)
          .maybeSingle();
        if (pkg) {
          const stripped = stripHeavyJson(pkg as unknown as Record<string, unknown>);
          if (stripped) packages_rows.push(stripped);
        }
      }
      if (pltId) {
        const { data: plt } = await supabaseServer
          .from("pallets")
          .select(PALLET_LIST_SELECT)
          .eq("organization_id", organizationId)
          .eq("id", pltId)
          .maybeSingle();
        if (plt) {
          const stripped = stripHeavyJson(plt as unknown as Record<string, unknown>);
          if (stripped) pallets_rows.push(stripped);
        }
      }
    }
  }

  const packageIdsForSlips = new Set<string>();
  for (const p of packages_rows) {
    const id = claimInboxStr(p.id);
    if (id) packageIdsForSlips.add(id);
  }
  const opPkg = operational_source_row ? claimInboxStr(operational_source_row.package_id) : null;
  if (opPkg) packageIdsForSlips.add(opPkg);

  let slip_contents: Record<string, unknown>[] = [];
  if (packageIdsForSlips.size > 0) {
    let sq = supabaseServer
      .from("slip_contents")
      .select(SLIP_CONTENTS_SELECT)
      .eq("organization_id", organizationId)
      .in("package_id", [...packageIdsForSlips])
      .order("sort_index", { ascending: true })
      .limit(500);
    if (storeId) sq = sq.eq("store_id", storeId);
    const { data: slips, error: slipErr } = await sq;
    if (!slipErr && slips) slip_contents = slips as unknown as Record<string, unknown>[];
  }

  let claim_submissions: unknown[] = [];
  if (returnId) {
    const { data: subs, error: subErr } = await supabaseServer
      .from("claim_submissions")
      .select("id, return_id, status, report_url, created_at, source_payload")
      .eq("organization_id", organizationId)
      .eq("return_id", returnId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (!subErr && subs) {
      claim_submissions = (subs as unknown as Record<string, unknown>[]).map((s) => {
        const payload = s.source_payload;
        const parsed = typeof payload === "string" ? safeJsonParse(payload) : payload;
        const urls =
          parsed && typeof parsed === "object" && "selected_claim_evidence_urls" in parsed
            ? (parsed as { selected_claim_evidence_urls?: unknown }).selected_claim_evidence_urls
            : null;
        return {
          id: claimInboxStr(s.id),
          return_id: claimInboxStr(s.return_id),
          status: claimInboxStr(s.status),
          report_url: claimInboxStr(s.report_url),
          created_at: s.created_at ?? null,
          source_payload: truncateJson(parsed),
          selected_claim_evidence_urls: urls,
        };
      });
    }
  }

  const selectedFromSubmission =
    claim_submissions[0] && typeof claim_submissions[0] === "object"
      ? (claim_submissions[0] as { selected_claim_evidence_urls?: unknown }).selected_claim_evidence_urls
      : null;

  return NextResponse.json({
    claim_candidate_id: candidateId,
    operational_source_row,
    operational_resolution: {
      alternate_tier: pack.alternateTier,
      id_lookup_hit: pack.id_lookup_hit,
      ambiguous_operational: pack.ambiguousOperational,
      op_reason_codes: pack.opReasonCodes,
    },
    projection: projection
      ? {
          inbox_queue: projection.inbox_queue,
          final_bucket: projection.final_bucket,
          badges: projection.badges,
          lineage_warning_code: projection.lineage_warning_code,
        }
      : null,
    returns_evidence,
    packages: packages_rows,
    pallets: pallets_rows,
    slip_contents,
    claim_submissions,
    selected_claim_evidence_urls: selectedFromSubmission ?? null,
  });
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return { parse_error: true, raw: s.slice(0, 2000) };
  }
}

async function resolveReturnIdForEvidence(
  organizationId: string,
  candidate: Record<string, unknown>,
  packRow: Record<string, unknown> | null,
): Promise<string | null> {
  const st = claimInboxStr(candidate.source_table)?.toLowerCase() ?? "";
  const sid = claimInboxStr(candidate.source_row_id);
  if ((st === "returns" || st === "return_items") && sid) return sid;
  if (st === "amazon_returns" && sid) {
    const { data: ar } = await supabaseServer
      .from("amazon_returns")
      .select("return_id, returns_id")
      .eq("organization_id", organizationId)
      .eq("id", sid)
      .maybeSingle();
    const arRow = ar as { return_id?: string | null; returns_id?: string | null } | null;
    const rid = claimInboxStr(arRow?.return_id) ?? claimInboxStr(arRow?.returns_id);
    if (rid) return rid;
  }
  if (packRow) {
    const r = claimInboxStr(packRow.return_id ?? packRow.returns_id);
    if (r) return r;
  }
  return null;
}
