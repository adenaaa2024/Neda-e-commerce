/**
 * PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1 — governed cache write.
 *
 * Persists the deterministic latest-sale-net backfill (per claim_submission_id) into
 * the canonical workspace_settings row under
 * `module_configs.claims.latest_sale_net_cache`. This is the ONLY approved write path
 * for this phase. Gated by an operator approval file. NEVER mutates claim_* tables,
 * never calls Amazon, never changes the scanner.
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LATEST_SALE_NET_CACHE_LOCATION,
  LATEST_SALE_NET_RESOLVER_V1,
  readLatestSaleNetCache,
  type CachedLatestSaleNetEntry,
  type LatestSaleNetResolution,
} from "./latest-sale-net-resolver-v1";

export const LATEST_SALE_NET_CACHE_WRITE_V1 = "latest-sale-net-cache-write-v1" as const;
export const LATEST_SALE_NET_BACKFILL_APPROVAL_KEY = "APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1";
export const LATEST_SALE_NET_BACKFILL_APPROVAL_PATH =
  ".cursor/operator-approvals/claim-latest-sale-net-source-backfill-v1-approval.md";

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readLatestSaleNetBackfillApproval(): { approved: boolean; block_reason: string | null } {
  const p = path.join(process.cwd(), LATEST_SALE_NET_BACKFILL_APPROVAL_PATH);
  if (!fs.existsSync(p)) {
    return { approved: false, block_reason: `${LATEST_SALE_NET_BACKFILL_APPROVAL_PATH} missing` };
  }
  const approved = new RegExp(`^${LATEST_SALE_NET_BACKFILL_APPROVAL_KEY}\\s*=\\s*yes\\s*$`, "im").test(
    fs.readFileSync(p, "utf8"),
  );
  return {
    approved,
    block_reason: approved
      ? null
      : `${LATEST_SALE_NET_BACKFILL_APPROVAL_KEY}=yes required in ${LATEST_SALE_NET_BACKFILL_APPROVAL_PATH}`,
  };
}

export type LatestSaleNetBackfillInput = {
  claim_submission_id: string;
  sku: string | null;
  resolution: LatestSaleNetResolution;
};

export type LatestSaleNetCacheWriteResult = {
  ok: boolean;
  blocked: boolean;
  block_reason: string | null;
  written: boolean;
  storage_location: string;
  workspace_settings_row_id: string | null;
  entries_before: number;
  entries_after: number;
  claim_counts_before: Record<string, number>;
  claim_counts_after: Record<string, number>;
};

async function claimCounts(client: SupabaseClient, organizationId: string): Promise<Record<string, number>> {
  const tables = ["claim_submissions", "claim_cases", "claim_lines", "claim_candidates", "claim_reference_edges"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count } = await client
      .from(t)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    out[t] = count ?? -1;
  }
  return out;
}

async function resolveCanonicalRow(
  client: SupabaseClient,
  organizationId: string,
): Promise<{ id: string; module_configs: Record<string, unknown> } | null> {
  const byOrg = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!byOrg.error && byOrg.data) {
    return {
      id: String((byOrg.data as { id: unknown }).id),
      module_configs: metaRecord((byOrg.data as { module_configs?: unknown }).module_configs),
    };
  }
  const singleton = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!singleton.error && singleton.data) {
    return {
      id: String((singleton.data as { id: unknown }).id),
      module_configs: metaRecord((singleton.data as { module_configs?: unknown }).module_configs),
    };
  }
  return null;
}

/**
 * Governed write: persists the deterministic backfill cache. Blocked unless the
 * operator approval file has APPROVED_LATEST_SALE_NET_SOURCE_BACKFILL_V1=yes.
 */
export async function writeLatestSaleNetCache(args: {
  client: SupabaseClient;
  organizationId: string;
  entries: LatestSaleNetBackfillInput[];
  actorId: string;
}): Promise<LatestSaleNetCacheWriteResult> {
  const storage = LATEST_SALE_NET_CACHE_LOCATION;
  const approval = readLatestSaleNetBackfillApproval();
  const claim_counts_before = await claimCounts(args.client, args.organizationId);
  const before = await readLatestSaleNetCache(args.client, args.organizationId);
  const entries_before = Object.keys(before).length;

  if (!approval.approved) {
    return {
      ok: false,
      blocked: true,
      block_reason: approval.block_reason,
      written: false,
      storage_location: storage,
      workspace_settings_row_id: null,
      entries_before,
      entries_after: entries_before,
      claim_counts_before,
      claim_counts_after: claim_counts_before,
    };
  }

  const resolvedAt = new Date().toISOString();
  const cacheEntries: Record<string, CachedLatestSaleNetEntry> = {};
  for (const e of args.entries) {
    cacheEntries[e.claim_submission_id] = {
      ...e.resolution,
      claim_submission_id: e.claim_submission_id,
      sku: e.sku,
      resolved_at: resolvedAt,
      resolver_version: LATEST_SALE_NET_RESOLVER_V1,
    };
  }

  const row = await resolveCanonicalRow(args.client, args.organizationId);
  if (!row?.id) {
    return {
      ok: false,
      blocked: false,
      block_reason: "No canonical workspace_settings row resolved.",
      written: false,
      storage_location: storage,
      workspace_settings_row_id: null,
      entries_before,
      entries_after: entries_before,
      claim_counts_before,
      claim_counts_after: claim_counts_before,
    };
  }

  const moduleConfigs = metaRecord(row.module_configs);
  const claims = metaRecord(moduleConfigs.claims);
  const nextModuleConfigs = {
    ...moduleConfigs,
    claims: {
      ...claims,
      latest_sale_net_cache: {
        version: LATEST_SALE_NET_CACHE_WRITE_V1,
        resolver_version: LATEST_SALE_NET_RESOLVER_V1,
        confirmed_by: args.actorId,
        confirmed_at: resolvedAt,
        approval_key: LATEST_SALE_NET_BACKFILL_APPROVAL_KEY,
        entries: cacheEntries,
      },
    },
  };

  const { data, error } = await args.client
    .from("workspace_settings")
    .update({ module_configs: nextModuleConfigs })
    .eq("id", row.id)
    .select("id");
  const claim_counts_after = await claimCounts(args.client, args.organizationId);

  if (error || (data?.length ?? 0) === 0) {
    return {
      ok: false,
      blocked: false,
      block_reason: error?.message ?? "workspace_settings write affected 0 rows.",
      written: false,
      storage_location: storage,
      workspace_settings_row_id: row.id,
      entries_before,
      entries_after: entries_before,
      claim_counts_before,
      claim_counts_after,
    };
  }

  const after = await readLatestSaleNetCache(args.client, args.organizationId);
  const entries_after = Object.keys(after).length;
  const persisted = args.entries.every((e) => e.claim_submission_id in after);

  return {
    ok: persisted,
    blocked: false,
    block_reason: persisted ? null : "Persistence verification failed: entries missing on re-read.",
    written: persisted,
    storage_location: storage,
    workspace_settings_row_id: row.id,
    entries_before,
    entries_after,
    claim_counts_before,
    claim_counts_after,
  };
}
