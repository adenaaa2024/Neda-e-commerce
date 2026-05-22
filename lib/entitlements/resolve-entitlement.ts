/**
 * NEXT-PLATFORM-ENTITLEMENTS-03 — Pure entitlement resolver skeleton.
 *
 * Static catalog only. No tenant subscription rows, no store overrides, no billing
 * provider, no database reads/writes. Do not treat `ok: true` as proof of a paid
 * commercial entitlement in production until a DB-backed resolver exists.
 *
 * Not wired to API routes in this slice — contract only for future routes/workers.
 */

import {
  type MeterKey,
  type ModuleKey,
  getFeature,
  getModule,
  isFeatureKey,
  isMeterKey,
  isModuleKey,
} from "./catalog";

/** Who / where the entitlement check applies (no I/O). */
export type EntitlementScope = {
  readonly organizationId: string;
  readonly storeId?: string | null;
  readonly userId?: string | null;
};

export type EntitlementStatus = "allow" | "deny" | "trial" | "not_cataloged";

/** Machine-readable denial causes for logging and future UI mapping. */
export type EntitlementDenyCode =
  | "FEATURE_NOT_CATALOGED"
  | "MODULE_NOT_CATALOGED"
  | "STORE_REQUIRED"
  | "STATICALLY_DISABLED"
  | "DEPENDENCY_DISABLED"
  | "USAGE_LIMIT_REQUIRED"
  | "INTERNAL_ERROR";

export type EntitlementDecision = {
  readonly ok: boolean;
  /** Requested key (may be absent from catalog). */
  readonly featureKey: string;
  readonly moduleKey: ModuleKey | null;
  readonly status: EntitlementStatus;
  readonly reasonCodes: readonly EntitlementDenyCode[];
  readonly requiresStore: boolean;
  readonly storeId?: string | null;
  /** Ordered explanation of how the decision was derived (no secrets). */
  readonly sourceTrace: readonly string[];
  readonly limits?: Readonly<Record<string, unknown>>;
};

export type ResolveEntitlementOptions = {
  /**
   * Feature keys to deny for tests or emergency kill-switches before DB exists.
   * Does not persist; callers must pass explicitly.
   */
  readonly staticDenyList?: readonly string[];
  /** @internal recursion guard — do not set from production callers */
  readonly _dependencyChain?: readonly string[];
};

function denyDecision(args: {
  readonly featureKey: string;
  readonly moduleKey: ModuleKey | null;
  readonly status: EntitlementStatus;
  readonly reasonCodes: readonly EntitlementDenyCode[];
  readonly requiresStore: boolean;
  readonly storeId?: string | null;
  readonly sourceTrace: readonly string[];
  readonly limits?: Readonly<Record<string, unknown>>;
}): EntitlementDecision {
  return {
    ok: false,
    featureKey: args.featureKey,
    moduleKey: args.moduleKey,
    status: args.status,
    reasonCodes: args.reasonCodes,
    requiresStore: args.requiresStore,
    storeId: args.storeId,
    sourceTrace: args.sourceTrace,
    limits: args.limits,
  };
}

function allowDecision(args: {
  readonly featureKey: string;
  readonly moduleKey: ModuleKey;
  readonly requiresStore: boolean;
  readonly storeId?: string | null;
  readonly sourceTrace: readonly string[];
  readonly limits?: Readonly<Record<string, unknown>>;
}): EntitlementDecision {
  return {
    ok: true,
    featureKey: args.featureKey,
    moduleKey: args.moduleKey,
    status: "allow",
    reasonCodes: [],
    requiresStore: args.requiresStore,
    storeId: args.storeId,
    sourceTrace: args.sourceTrace,
    limits: args.limits,
  };
}

/**
 * Resolves whether a feature is allowed under the static skeleton policy.
 * Catalog validation + optional static deny list + store requirement + dependency walk.
 */
export function resolveEntitlement(
  featureKey: string,
  scope: EntitlementScope,
  options?: ResolveEntitlementOptions,
): EntitlementDecision {
  const traceBase = [
    "resolver:static_catalog_only",
    "policy:no_tenant_subscription_data",
    "policy:no_store_entitlement_overrides",
    "policy:no_billing_provider",
    "policy:no_db",
  ] as const;

  const chain = options?._dependencyChain ?? [];

  if (chain.includes(featureKey)) {
    return denyDecision({
      featureKey,
      moduleKey: null,
      status: "deny",
      reasonCodes: ["INTERNAL_ERROR"],
      requiresStore: false,
      storeId: scope.storeId,
      sourceTrace: [...traceBase, "error:dependency_cycle", `cycle_at:${featureKey}`],
    });
  }

  if (!isFeatureKey(featureKey)) {
    return denyDecision({
      featureKey,
      moduleKey: null,
      status: "not_cataloged",
      reasonCodes: ["FEATURE_NOT_CATALOGED"],
      requiresStore: false,
      storeId: scope.storeId,
      sourceTrace: [...traceBase, `feature:${featureKey}`, "outcome:not_in_FEATURE_CATALOG"],
    });
  }

  const feat = getFeature(featureKey);
  const modKey = feat.moduleKey;

  if (!isModuleKey(modKey)) {
    return denyDecision({
      featureKey,
      moduleKey: null,
      status: "deny",
      reasonCodes: ["MODULE_NOT_CATALOGED"],
      requiresStore: feat.requiresStore,
      storeId: scope.storeId,
      sourceTrace: [...traceBase, `feature:${featureKey}`, `module_key_invalid:${modKey}`],
    });
  }

  const moduleKey = modKey;
  void getModule(moduleKey);

  if (feat.requiresStore && (scope.storeId == null || String(scope.storeId).trim() === "")) {
    return denyDecision({
      featureKey,
      moduleKey,
      status: "deny",
      reasonCodes: ["STORE_REQUIRED"],
      requiresStore: true,
      storeId: scope.storeId,
      sourceTrace: [...traceBase, `feature:${featureKey}`, "outcome:store_id_missing"],
    });
  }

  const denyList = options?.staticDenyList ?? [];
  if (denyList.includes(featureKey)) {
    return denyDecision({
      featureKey,
      moduleKey,
      status: "deny",
      reasonCodes: ["STATICALLY_DISABLED"],
      requiresStore: feat.requiresStore,
      storeId: scope.storeId,
      sourceTrace: [...traceBase, `feature:${featureKey}`, "policy:static_deny_list_hit"],
    });
  }

  for (const dep of feat.dependencies) {
    const depRes = resolveEntitlement(dep, scope, {
      ...options,
      _dependencyChain: [...chain, featureKey],
    });
    if (!depRes.ok) {
      return denyDecision({
        featureKey,
        moduleKey,
        status: "deny",
        reasonCodes: ["DEPENDENCY_DISABLED"],
        requiresStore: feat.requiresStore,
        storeId: scope.storeId,
        sourceTrace: [
          ...traceBase,
          `feature:${featureKey}`,
          `dependency:${dep}`,
          `dependency_outcome:${depRes.reasonCodes.join(",")}`,
        ],
      });
    }
  }

  return allowDecision({
    featureKey,
    moduleKey,
    requiresStore: feat.requiresStore,
    storeId: scope.storeId,
    sourceTrace: [
      ...traceBase,
      `feature:${featureKey}`,
      `module:${moduleKey}`,
      "outcome:default_allow_cataloged_until_db_resolver",
    ],
  });
}

/**
 * Same as {@link resolveEntitlement} — returns a decision object (no throw on deny).
 * Name mirrors other "assert*" guards that return structured results in this codebase.
 */
export function assertEntitlement(
  featureKey: string,
  scope: EntitlementScope,
  options?: ResolveEntitlementOptions,
): EntitlementDecision {
  return resolveEntitlement(featureKey, scope, options);
}

/** Thrown by {@link requireEntitlement} when the decision is not allowed. */
export class EntitlementError extends Error {
  readonly decision: EntitlementDecision;

  constructor(decision: EntitlementDecision) {
    super(`Entitlement denied: ${decision.featureKey} (${decision.reasonCodes.join(", ")})`);
    this.name = "EntitlementError";
    this.decision = decision;
  }
}

/** Returns the decision when allowed; throws {@link EntitlementError} when denied. */
export function requireEntitlement(
  featureKey: string,
  scope: EntitlementScope,
  options?: ResolveEntitlementOptions,
): EntitlementDecision {
  const d = resolveEntitlement(featureKey, scope, options);
  if (!d.ok) throw new EntitlementError(d);
  return d;
}

/** Meter keys attached to a cataloged feature (empty if unknown key). */
export function getFeatureMeters(featureKey: string): readonly MeterKey[] {
  if (!isFeatureKey(featureKey)) return [];
  const out: MeterKey[] = [];
  for (const m of getFeature(featureKey).meterKeys) {
    if (isMeterKey(m)) out.push(m);
  }
  return out;
}

/** Declared dependency feature keys (empty if unknown key). */
export function getFeatureDependencies(featureKey: string): readonly string[] {
  if (!isFeatureKey(featureKey)) return [];
  return getFeature(featureKey).dependencies;
}

export type UsageLimitScope = EntitlementScope & {
  readonly meterKey?: string | null;
  readonly requestedQuantity?: number;
};

export type UsageLimitDecision = {
  readonly ok: true;
  readonly reasonCodes: readonly ["USAGE_NOT_ENFORCED_STATIC"];
  readonly sourceTrace: readonly string[];
};

/**
 * Placeholder: usage caps and credits are not enforced until metering + DB exist.
 */
export function resolveUsageLimit(scope: UsageLimitScope, meterKey: string): UsageLimitDecision {
  void scope;
  void meterKey;
  return {
    ok: true,
    reasonCodes: ["USAGE_NOT_ENFORCED_STATIC"],
    sourceTrace: [
      "usage:resolveUsageLimit_placeholder",
      "policy:no_usage_tables",
      "policy:no_billing",
    ],
  };
}

export type RecordUsageEventInput = {
  readonly organizationId: string;
  readonly storeId?: string | null;
  readonly userId?: string | null;
  readonly featureKey?: string | null;
  readonly meterKey: string;
  readonly quantity?: number;
  readonly idempotencyKey?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type RecordUsageEventResult = {
  readonly status: "skipped_static_noop";
  readonly message: string;
};

/**
 * Explicit no-op: does not write to DB or call billing. Safe to call from stubs only.
 */
export function recordUsageEventNoop(input: RecordUsageEventInput): RecordUsageEventResult {
  void input;
  return {
    status: "skipped_static_noop",
    message:
      "recordUsageEventNoop: no persistence; not for production billing. Replace with real metering later.",
  };
}
