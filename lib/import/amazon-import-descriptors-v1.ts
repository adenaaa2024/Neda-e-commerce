/**
 * Amazon ImportDescriptorV1 catalog — derived from AMAZON_REPORT_REGISTRY (single source of truth).
 * Does not alter production import behavior; consumed by validation tests and future wiring.
 */

import type { AmazonReportFamily, AmazonSyncKind } from "../pipeline/amazon-report-registry";
import {
  AMAZON_REPORT_REGISTRY,
  isListingAmazonSyncKind,
  requiresPhase4Generic,
} from "../pipeline/amazon-report-registry";
import type { RawReportType } from "../raw-report-types";
import {
  IMPORT_DESCRIPTOR_VERSION,
  type ImportDescriptorV1,
  type ImportSourceFamily,
  type Phase4EffectRef,
  type ProductAttachmentStrategy,
  type TridReferenceStrategy,
} from "./import-descriptor-v1";

export const PHASE4_EFFECT_CATALOG: Record<
  string,
  { handler_module: string; import_kinds: AmazonSyncKind[] }
> = {
  frr_upsert: {
    handler_module: "lib/financial-reference-resolver-sync.ts",
    import_kinds: ["SETTLEMENT", "TRANSACTIONS", "REIMBURSEMENTS"],
  },
  ledger_pim_bridge: {
    handler_module: "lib/inventory-ledger-generic-completion.ts",
    import_kinds: ["INVENTORY_LEDGER"],
  },
  reports_repo_complete: {
    handler_module: "lib/reports-repository-generic-completion.ts",
    import_kinds: ["REPORTS_REPOSITORY"],
  },
  listing_catalog_upsert: {
    handler_module: "lib/pipeline/listing-import-complete-from-staging.ts",
    import_kinds: ["CATEGORY_LISTINGS", "ALL_LISTINGS", "ACTIVE_LISTINGS"],
  },
  removal_shipment_tree: {
    handler_module: "app/api/settings/imports/generic/route.ts",
    import_kinds: ["REMOVAL_SHIPMENT"],
  },
};

function sourceFamilyFromReportFamily(family: AmazonReportFamily): ImportSourceFamily {
  switch (family) {
    case "financial":
      return "marketplace_financial";
    case "ledger":
      return "marketplace_inventory";
    case "removal":
      return "marketplace_removal";
    case "returns":
      return "marketplace_returns";
    case "repository":
      return "marketplace_repository";
    case "listing":
      return "marketplace_listing";
    case "identity":
      return "marketplace_identity";
    case "archive":
      return "marketplace_archive";
    case "safet":
      return "marketplace_financial";
    default:
      return "unknown";
  }
}

function parserProfileForKind(kind: AmazonSyncKind): string {
  if (kind === "INVENTORY_LEDGER") return "csv_headers_or_ledger_positional";
  if (kind === "SETTLEMENT") return "csv_headers_or_tsv_flat";
  if (kind === "REPORTS_REPOSITORY") return "reports_repo_preamble";
  if (isListingAmazonSyncKind(kind)) return "batch_listing_physical_lines";
  return "csv_headers";
}

function productAttachmentForKind(kind: AmazonSyncKind): ProductAttachmentStrategy {
  if (kind === "INVENTORY_LEDGER") return "ledger_pim";
  if (isListingAmazonSyncKind(kind)) return "listing_catalog";
  if (kind === "PRODUCT_IDENTITY") return "identity_csv";
  return "none";
}

function tridStrategyForKind(kind: AmazonSyncKind): TridReferenceStrategy {
  if (kind === "SETTLEMENT" || kind === "TRANSACTIONS" || kind === "REIMBURSEMENTS") {
    return "frr_from_domain";
  }
  if (kind === "PRODUCT_IDENTITY") return "none";
  return "graph_only";
}

function requiredIdentifiersForKind(kind: AmazonSyncKind): string[] {
  switch (kind) {
    case "REIMBURSEMENTS":
      return ["reimbursement_id"];
    case "SETTLEMENT":
      return ["settlement_id"];
    case "TRANSACTIONS":
      return ["order_id"];
    case "SAFET_CLAIMS":
      return ["safet_claim_id"];
    case "FBA_RETURNS":
      return ["order_id"];
    case "REMOVAL_ORDER":
    case "REMOVAL_SHIPMENT":
      return ["order_id"];
    case "INVENTORY_LEDGER":
      return ["fnsku"];
    case "ALL_ORDERS":
      return ["amazon_order_id"];
    case "PRODUCT_IDENTITY":
      return ["seller_sku", "asin"];
    default:
      return [];
  }
}

function optionalIdentifiersForKind(kind: AmazonSyncKind): string[] {
  switch (kind) {
    case "SETTLEMENT":
      return ["order_id", "sku", "amazon_line_key"];
    case "REIMBURSEMENTS":
      return ["order_id", "sku"];
    case "REMOVAL_SHIPMENT":
      return ["tracking_number", "sku", "fnsku"];
    case "ALL_ORDERS":
      return ["shipment_id", "sku"];
    case "FBA_RETURNS":
      return ["lpn", "sku", "asin"];
    default:
      return [];
  }
}

/** Expected Phase-4 effects per kind — mirrors `app/api/settings/imports/generic/route.ts`. */
export function expectedPhase4EffectsForKind(kind: AmazonSyncKind): Phase4EffectRef[] {
  if (!requiresPhase4Generic(kind)) return [];

  if (kind === "REMOVAL_SHIPMENT") {
    return [
      {
        effect_key: "removal_shipment_tree",
        ordering: 5,
        blocking: true,
        handler_module: PHASE4_EFFECT_CATALOG.removal_shipment_tree.handler_module,
      },
    ];
  }
  if (isListingAmazonSyncKind(kind)) {
    return [
      {
        effect_key: "listing_catalog_upsert",
        ordering: 30,
        blocking: true,
        handler_module: PHASE4_EFFECT_CATALOG.listing_catalog_upsert.handler_module,
      },
    ];
  }
  if (kind === "INVENTORY_LEDGER") {
    return [
      {
        effect_key: "ledger_pim_bridge",
        ordering: 20,
        blocking: false,
        handler_module: PHASE4_EFFECT_CATALOG.ledger_pim_bridge.handler_module,
      },
    ];
  }
  if (kind === "REPORTS_REPOSITORY") {
    return [
      {
        effect_key: "reports_repo_complete",
        ordering: 40,
        blocking: false,
        handler_module: PHASE4_EFFECT_CATALOG.reports_repo_complete.handler_module,
      },
    ];
  }
  if (kind === "SETTLEMENT" || kind === "TRANSACTIONS" || kind === "REIMBURSEMENTS") {
    return [
      {
        effect_key: "frr_upsert",
        ordering: 10,
        blocking: true,
        handler_module: PHASE4_EFFECT_CATALOG.frr_upsert.handler_module,
      },
    ];
  }

  return [];
}

function canonicalReportTypeForKind(kind: AmazonSyncKind): RawReportType {
  return kind as RawReportType;
}

/** Build a registry-mirrored descriptor for one Amazon sync kind. */
export function buildAmazonImportDescriptorFromRegistry(kind: AmazonSyncKind): ImportDescriptorV1 {
  const entry = AMAZON_REPORT_REGISTRY[kind];
  const phase4 = expectedPhase4EffectsForKind(kind);

  return {
    descriptor_id: `amazon.${kind.toLowerCase()}.file.v1`,
    descriptor_version: IMPORT_DESCRIPTOR_VERSION,
    implementation_status: kind === "UNKNOWN" ? "planned" : "live",

    provider: "amazon",
    source_family: sourceFamilyFromReportFamily(entry.report_family),
    report_type: kind === "UNKNOWN" ? null : canonicalReportTypeForKind(kind),
    import_kind: kind === "UNKNOWN" ? null : kind,
    source_mode: kind === "REPORTS_REPOSITORY" ? "repository" : "file",

    parser_profile: parserProfileForKind(kind),
    staging_table: entry.stage_target_table,
    staging_dedupe_mode: entry.dedupeMode,
    staging_conflict_columns: entry.conflictColumns,
    sync_target_table: entry.sync_target_table,

    registry_mirror: kind !== "UNKNOWN",
    required_identifiers: requiredIdentifiersForKind(kind),
    optional_identifiers: optionalIdentifiersForKind(kind),
    product_attachment_strategy: productAttachmentForKind(kind),
    trid_reference_strategy: tridStrategyForKind(kind),

    phase4_effects: phase4,
    post_sync_hooks:
      entry.generateWorklistAfterSync && kind === "REMOVAL_ORDER"
        ? [{ hook_key: "worklist_after_sync", implementation_status: "live" }]
        : [],

    idempotency_scope:
      entry.dedupeMode === "settlement_line" || entry.dedupeMode === "safet_claim_id"
        ? "business_key"
        : "physical_line",
    retry_policy_id: "amazon_unified_v1_default",
    safe_replay_behavior: "skip_if_same_document_sha",
    progress_stages: requiresPhase4Generic(kind)
      ? ["upload", "staging", "sync", "generic", "complete"]
      : ["upload", "staging", "sync", "complete"],
  };
}

const AMAZON_SYNC_KINDS = Object.keys(AMAZON_REPORT_REGISTRY) as AmazonSyncKind[];

/** All registry-backed file descriptors (includes UNKNOWN as planned). */
export const AMAZON_IMPORT_DESCRIPTORS_V1: ImportDescriptorV1[] = AMAZON_SYNC_KINDS.map((k) =>
  buildAmazonImportDescriptorFromRegistry(k),
);

/** Live mirrored descriptors — one per kind except UNKNOWN. */
export const AMAZON_REGISTRY_MIRROR_DESCRIPTORS_V1: ImportDescriptorV1[] =
  AMAZON_IMPORT_DESCRIPTORS_V1.filter((d) => d.registry_mirror && d.import_kind && d.import_kind !== "UNKNOWN");

export function getAmazonDescriptorByKind(kind: AmazonSyncKind): ImportDescriptorV1 | undefined {
  return AMAZON_IMPORT_DESCRIPTORS_V1.find((d) => d.import_kind === kind);
}

export function getAmazonDescriptorById(descriptorId: string): ImportDescriptorV1 | undefined {
  return AMAZON_IMPORT_DESCRIPTORS_V1.find((d) => d.descriptor_id === descriptorId);
}
