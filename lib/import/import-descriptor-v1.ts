/**
 * ImportDescriptorV1 — versioned import contract (NEXT-IMPORT-02 / NEXT-IMPORT-03).
 * Read-only metadata; does not change runtime sync behavior.
 */

import type { AmazonSyncKind, DedupeMode } from "../pipeline/amazon-report-registry";
import type { RawReportType } from "../raw-report-types";

export const IMPORT_DESCRIPTOR_VERSION = 1 as const;

export type ImportDescriptorImplementationStatus = "live" | "partial" | "planned";

export type ImportSourceMode = "file" | "api" | "repository" | "manual" | "ocr_scanner";

export type ImportProvider = "amazon" | "walmart" | "shopify" | "ebay" | "internal";

export type ImportSourceFamily =
  | "marketplace_financial"
  | "marketplace_inventory"
  | "marketplace_shipment"
  | "marketplace_removal"
  | "marketplace_returns"
  | "marketplace_repository"
  | "marketplace_listing"
  | "marketplace_identity"
  | "marketplace_archive"
  | "warehouse_scanner"
  | "unknown";

export type ProductAttachmentStrategy =
  | "none"
  | "ledger_pim"
  | "listing_catalog"
  | "identity_csv"
  | "scanner_linkage_deferred"
  | "future_graph";

export type TridReferenceStrategy =
  | "frr_from_domain"
  | "graph_only"
  | "reconciler_pending"
  | "none";

export type IdempotencyScope = "upload" | "physical_line" | "business_key";

export type SafeReplayBehavior =
  | "skip_if_same_document_sha"
  | "new_upload_row"
  | "append_only_api_run";

/** Stable Phase-4 effect keys — must match generic route handlers. */
export type Phase4EffectKey =
  | "frr_upsert"
  | "ledger_pim_bridge"
  | "reports_repo_complete"
  | "listing_catalog_upsert"
  | "removal_shipment_tree"
  | "finances_event_archive"
  | "repository_financial_promotion"
  | "trid_candidate_refresh";

export type Phase4EffectRef = {
  effect_key: Phase4EffectKey;
  ordering: number;
  blocking: boolean;
  handler_module?: string;
};

export type PostSyncHookRef = {
  hook_key: string;
  implementation_status: ImportDescriptorImplementationStatus;
};

export type ImportDescriptorV1 = {
  descriptor_id: string;
  descriptor_version: typeof IMPORT_DESCRIPTOR_VERSION;
  implementation_status: ImportDescriptorImplementationStatus;

  provider: ImportProvider;
  source_family: ImportSourceFamily;
  report_type: RawReportType | null;
  import_kind: AmazonSyncKind | null;
  source_mode: ImportSourceMode;

  parser_profile: string;
  staging_table: string;
  staging_dedupe_mode: DedupeMode;
  staging_conflict_columns: string | null;
  sync_target_table: string | null;

  /** When true, staging/sync/generic fields must match AMAZON_REPORT_REGISTRY[import_kind]. */
  registry_mirror: boolean;

  required_identifiers: string[];
  optional_identifiers: string[];
  product_attachment_strategy: ProductAttachmentStrategy;
  trid_reference_strategy: TridReferenceStrategy;

  phase4_effects: Phase4EffectRef[];
  post_sync_hooks: PostSyncHookRef[];

  idempotency_scope: IdempotencyScope;
  retry_policy_id: string;
  safe_replay_behavior: SafeReplayBehavior;
  progress_stages: string[];
};

export type DescriptorValidationIssue = {
  code: string;
  message: string;
  descriptor_id?: string;
};

export function isKnownPhase4EffectKey(key: string): key is Phase4EffectKey {
  return (
    key === "frr_upsert" ||
    key === "ledger_pim_bridge" ||
    key === "reports_repo_complete" ||
    key === "listing_catalog_upsert" ||
    key === "removal_shipment_tree" ||
    key === "finances_event_archive" ||
    key === "repository_financial_promotion" ||
    key === "trid_candidate_refresh"
  );
}

/** Phase-4 keys implemented in production generic route today (not planned-only). */
export const PHASE4_EFFECT_KEYS_LIVE_IN_GENERIC_ROUTE: readonly Phase4EffectKey[] = [
  "frr_upsert",
  "ledger_pim_bridge",
  "reports_repo_complete",
  "listing_catalog_upsert",
  "removal_shipment_tree",
] as const;

export function validateImportDescriptorV1Shape(d: ImportDescriptorV1): DescriptorValidationIssue[] {
  const issues: DescriptorValidationIssue[] = [];
  const id = d.descriptor_id;

  if (d.descriptor_version !== IMPORT_DESCRIPTOR_VERSION) {
    issues.push({
      code: "bad_version",
      descriptor_id: id,
      message: `descriptor_version must be ${IMPORT_DESCRIPTOR_VERSION}, got ${String(d.descriptor_version)}`,
    });
  }
  if (!id || !/^[a-z0-9._-]+$/.test(id)) {
    issues.push({ code: "bad_descriptor_id", descriptor_id: id, message: "descriptor_id must be a non-empty slug" });
  }
  if (d.registry_mirror && !d.import_kind) {
    issues.push({
      code: "mirror_requires_kind",
      descriptor_id: id,
      message: "registry_mirror descriptors require import_kind",
    });
  }
  if (d.import_kind === "UNKNOWN" && d.registry_mirror) {
    issues.push({
      code: "unknown_not_mirrored",
      descriptor_id: id,
      message: "UNKNOWN cannot use registry_mirror",
    });
  }

  for (const eff of d.phase4_effects) {
    if (!isKnownPhase4EffectKey(eff.effect_key)) {
      issues.push({
        code: "unknown_effect_key",
        descriptor_id: id,
        message: `Unknown phase4 effect_key: ${eff.effect_key}`,
      });
    }
  }

  const orderings = d.phase4_effects.map((e) => e.ordering);
  if (new Set(orderings).size !== orderings.length) {
    issues.push({
      code: "duplicate_phase4_ordering",
      descriptor_id: id,
      message: "phase4_effects ordering values must be unique within a descriptor",
    });
  }

  return issues;
}
