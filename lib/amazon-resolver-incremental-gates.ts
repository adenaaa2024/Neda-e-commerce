/**
 * NEXT-UNIVERSAL-RESOLVER-08 — Per-table incremental resolver gates (env-driven).
 * No table runs incremental orchestration unless master pipeline + explicit table gate allow it.
 */

import type { ResolveTargetTable } from "./amazon-import-product-resolver";
import type { IncrementalResolverGovernance } from "./amazon-resolver-incremental-orchestrator";
import { isUuidString } from "./uuid";

export type IncrementalResolverTableGateMeta = {
  readonly envSuffix: string;
  /**
   * When true, missing per-table env defaults to "open" if master pipeline is on (legacy: returns pilot).
   * New operational tables should omit so explicit `RESOLVER_INCREMENTAL_TABLE_<SUFFIX>=1` is required.
   */
  readonly defaultOpenWhenMasterOn?: boolean;
  /** Extra prerequisite for sync-time wiring (e.g. returns post-sync flag). */
  readonly requiresReturnsPostSync?: boolean;
  /** Resolver never auto-creates products in this codebase; reserved for future audited bridges. */
  readonly productCreationAllowed: false;
};

export const INCREMENTAL_RESOLVER_TABLE_GATE: Record<ResolveTargetTable, IncrementalResolverTableGateMeta> = {
  amazon_all_orders: { envSuffix: "AMAZON_ALL_ORDERS", productCreationAllowed: false },
  amazon_settlements: { envSuffix: "AMAZON_SETTLEMENTS", productCreationAllowed: false },
  amazon_transactions: { envSuffix: "AMAZON_TRANSACTIONS", productCreationAllowed: false },
  amazon_inventory_ledger: { envSuffix: "AMAZON_INVENTORY_LEDGER", productCreationAllowed: false },
  amazon_manage_fba_inventory: { envSuffix: "AMAZON_MANAGE_FBA_INVENTORY", productCreationAllowed: false },
  amazon_fba_inventory: { envSuffix: "AMAZON_FBA_INVENTORY", productCreationAllowed: false },
  amazon_amazon_fulfilled_inventory: { envSuffix: "AMAZON_FULFILLED_INVENTORY", productCreationAllowed: false },
  amazon_returns: {
    envSuffix: "AMAZON_RETURNS",
    defaultOpenWhenMasterOn: true,
    requiresReturnsPostSync: true,
    productCreationAllowed: false,
  },
};

export function incrementalResolverTableEnvSuffix(table: ResolveTargetTable): string {
  return INCREMENTAL_RESOLVER_TABLE_GATE[table].envSuffix;
}

function isTruthyEnv(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1";
}

function isFalsyEnv(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "false" || v === "0";
}

function scopedEnv(base: string, suffix: string): string | undefined {
  const k = `${base}_${suffix}`;
  const v = process.env[k];
  if (v !== undefined && String(v).trim() !== "") return v;
  return process.env[base];
}

export function isResolverIncrementalMasterEnabled(): boolean {
  return isTruthyEnv(process.env.RESOLVER_INCREMENTAL_PIPELINE);
}

/**
 * Per-table incremental orchestration (upload-scoped). When false, sync keeps legacy direct resolver.
 */
export function shouldUseIncrementalOrchestrator(
  table: ResolveTargetTable,
  ctx: { returnsPostSyncResolverActive?: boolean },
): boolean {
  if (!isResolverIncrementalMasterEnabled()) return false;
  const meta = INCREMENTAL_RESOLVER_TABLE_GATE[table];
  if (!meta) return false;
  if (meta.requiresReturnsPostSync && !ctx.returnsPostSyncResolverActive) return false;

  const tableKey = `RESOLVER_INCREMENTAL_TABLE_${meta.envSuffix}`;
  const raw = process.env[tableKey];
  if (isFalsyEnv(raw)) return false;
  if (isTruthyEnv(raw)) return true;
  if (meta.defaultOpenWhenMasterOn && (raw === undefined || String(raw).trim() === "")) {
    return true;
  }
  return false;
}

const MAX_ONLY_ROW_IDS = 80;

export function parseOptionalOnlyRowIdsForTable(table: ResolveTargetTable): string[] | undefined {
  const suffix = incrementalResolverTableEnvSuffix(table);
  const raw = process.env[`RESOLVER_INCREMENTAL_ONLY_ROW_IDS_${suffix}`]?.trim();
  if (!raw) return undefined;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ids: string[] = [];
  for (const p of parts) {
    if (!isUuidString(p)) continue;
    ids.push(p);
    if (ids.length >= MAX_ONLY_ROW_IDS) break;
  }
  return ids.length > 0 ? ids : undefined;
}

export type IncrementalResolverEnvOptions = {
  governance: IncrementalResolverGovernance;
  verifyOnly: boolean;
  allowExecute: boolean;
  onlyRowIds?: string[];
};

/**
 * Reads governance flags; table-scoped env overrides global (`RESOLVER_INCREMENTAL_*_<SUFFIX>`).
 */
export function readIncrementalResolverOptionsFromEnv(table: ResolveTargetTable): IncrementalResolverEnvOptions {
  const suffix = incrementalResolverTableEnvSuffix(table);
  const laneB = isTruthyEnv(scopedEnv("RESOLVER_INCREMENTAL_LANE_B", suffix));
  const verifyOnly = isTruthyEnv(scopedEnv("RESOLVER_INCREMENTAL_VERIFY_ONLY", suffix));
  const allowExecute = !isFalsyEnv(scopedEnv("RESOLVER_INCREMENTAL_EXECUTE", suffix));
  const maxRaw = scopedEnv("RESOLVER_INCREMENTAL_MAX_AMBIGUOUS_RATIO", suffix);
  const maxAmbiguousRatioForExecute =
    maxRaw != null && String(maxRaw).trim() !== ""
      ? Number(maxRaw)
      : undefined;
  const onlyRowIds = parseOptionalOnlyRowIdsForTable(table);

  return {
    governance: {
      lane: laneB ? "B" : "A",
      laneB_preflight: laneB,
      maxAmbiguousRatioForExecute:
        typeof maxAmbiguousRatioForExecute === "number" && Number.isFinite(maxAmbiguousRatioForExecute)
          ? maxAmbiguousRatioForExecute
          : undefined,
    },
    verifyOnly,
    allowExecute,
    onlyRowIds,
  };
}
