/**
 * Pure types for entitlement catalogs (NEXT-PLATFORM-ENTITLEMENTS-02).
 * No runtime I/O — see catalog.ts for data and helpers.
 */

export type ModuleScope = "tenant" | "store" | "hybrid" | "platform";

export type FeatureRisk = "low" | "medium" | "high";

/** Normalized billing / metering unit for a meter definition. */
export type MeterUnit =
  | "count"
  | "token"
  | "credit"
  | "gb_month"
  | "boolean_slot"
  | "page"
  | "call"
  | "file"
  | "row";

export type AggregationWindow = "none" | "hour" | "day" | "month" | "billing_period";

export type ModuleCatalogEntry = {
  readonly displayName: string;
  readonly scope: ModuleScope;
  readonly description: string;
  /** Other modules that should be present for a typical rollout; absence does not imply runtime failure. */
  readonly dependencies: readonly string[];
  readonly standaloneBehavior: string;
};

export type FeatureCatalogEntry = {
  readonly moduleKey: string;
  readonly scope: ModuleScope;
  readonly risk: FeatureRisk;
  readonly requiresStore: boolean;
  readonly meterKeys: readonly string[];
  readonly dependencies: readonly string[];
  /** User-visible / operator outcome when entitlement denies this feature. */
  readonly disabledBehavior: string;
};

export type MeterCatalogEntry = {
  readonly displayName: string;
  readonly unit: MeterUnit;
  readonly billable: boolean;
  readonly aggregationWindow: AggregationWindow;
  /** Human-readable idempotency boundary (e.g. "per organization per request id"). */
  readonly idempotencyScope: string;
};
