/**
 * Scanner-origin Task Center display contract (future source filters only).
 * Phase 7A: no scanner task rows created; no scanner UI changes.
 */

import type { TaskCenterSourceModule } from "./task-center-schema-contract";

/** Allowed source_entity_type values when source_module = scanner (DB comment + UI contract) */
export const TASK_CENTER_SCANNER_SOURCE_ENTITY_TYPES = [
  "return_item",
  "package",
  "pallet",
  "shipment_review",
  "box_review",
  "pallet_review",
  "scan_problem",
  "missing_review",
  "damaged_item",
  "over_received",
  "unexpected_item",
  "photo_missing",
  "operator_correction",
] as const;

export type TaskCenterScannerSourceEntityType =
  (typeof TASK_CENTER_SCANNER_SOURCE_ENTITY_TYPES)[number];

/** Future UI filter chips on /task-center/sources/scanner */
export const TASK_CENTER_SCANNER_UI_SOURCE_KINDS = [
  { id: "damaged_item_photo", title: "Damaged item photo", entityTypes: ["damaged_item"] as const },
  { id: "missing_before_close", title: "Missing before close", entityTypes: ["missing_review", "scan_problem"] as const },
  { id: "over_received", title: "Over received", entityTypes: ["over_received"] as const },
  { id: "unexpected_item", title: "Unexpected item", entityTypes: ["unexpected_item"] as const },
  { id: "box_review_reopen", title: "Box review reopen", entityTypes: ["box_review"] as const },
  { id: "pallet_review_reopen", title: "Pallet review reopen", entityTypes: ["pallet_review"] as const },
  { id: "shipment_review_reopen", title: "Shipment review reopen", entityTypes: ["shipment_review"] as const },
  { id: "operator_correction_review", title: "Operator correction review", entityTypes: ["operator_correction"] as const },
  { id: "missing_packing_slip", title: "Missing packing slip", entityTypes: ["scan_problem"] as const },
  { id: "product_link_missing", title: "Product link missing", entityTypes: ["return_item"] as const },
] as const;

export type TaskCenterScannerUiSourceKind =
  (typeof TASK_CENTER_SCANNER_UI_SOURCE_KINDS)[number]["id"];

export const TASK_CENTER_SCANNER_ENTITY_TYPE_LABELS: Record<
  TaskCenterScannerSourceEntityType,
  string
> = {
  return_item: "Return item",
  package: "Package",
  pallet: "Pallet",
  shipment_review: "Shipment review",
  box_review: "Box review",
  pallet_review: "Pallet review",
  scan_problem: "Scan problem",
  missing_review: "Missing review",
  damaged_item: "Damaged item",
  over_received: "Over received",
  unexpected_item: "Unexpected item",
  photo_missing: "Photo missing",
  operator_correction: "Operator correction",
};

/** Frozen snapshot keys Task Center may render from source_snapshot (read-only) */
export type TaskCenterScannerSourceSnapshot = {
  source_module: Extract<TaskCenterSourceModule, "scanner">;
  source_entity_type: TaskCenterScannerSourceEntityType;
  source_entity_id: string;
  review_scope?: "box" | "pallet" | "shipment";
  package_id?: string | null;
  package_code?: string | null;
  pallet_id?: string | null;
  shipment_tracking?: string | null;
  return_item_id?: string | null;
  bucket_label?: string | null;
  line_label?: string | null;
  qty_affected?: number | null;
  has_photo?: boolean;
  deep_link_href?: string | null;
  /** Hydrated via ProductLinkageDisplayContract when product row involved */
  product_linkage?: Record<string, unknown> | null;
};

export const TASK_CENTER_SCANNER_PHASE_NOTICE =
  "Scanner task bridge deferred — tasks display as future source filters only. No scanner mutations from Task Center.";
