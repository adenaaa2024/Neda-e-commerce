/**
 * Flat permission keys for operator mobile correction actions (Platform Access catalog).
 * Synced via `lib/sidebar-catalog-extras.ts` → `npm run sync:sidebar`.
 */

export const OPERATOR_MOBILE_MOVE_BOX = "operations.operator_mobile.move_box" as const;
export const OPERATOR_MOBILE_VOID_BOX = "operations.operator_mobile.void_box" as const;
export const OPERATOR_MOBILE_RESET_ENTRY = "operations.operator_mobile.reset_entry" as const;
export const OPERATOR_MOBILE_EDIT_ITEM = "operations.operator_mobile.edit_item" as const;
export const OPERATOR_MOBILE_DELETE_ITEM = "operations.operator_mobile.delete_item" as const;
export const OPERATOR_MOBILE_CLOSE_PALLET = "operations.operator_mobile.close_pallet" as const;
export const OPERATOR_MOBILE_REOPEN_PALLET = "operations.operator_mobile.reopen_pallet" as const;
export const OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW =
  "operations.operator_mobile.close_shipment_review" as const;
export const OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW =
  "operations.operator_mobile.reopen_shipment_review" as const;

export type OperatorMobilePermissionKey =
  | typeof OPERATOR_MOBILE_MOVE_BOX
  | typeof OPERATOR_MOBILE_VOID_BOX
  | typeof OPERATOR_MOBILE_RESET_ENTRY
  | typeof OPERATOR_MOBILE_EDIT_ITEM
  | typeof OPERATOR_MOBILE_DELETE_ITEM
  | typeof OPERATOR_MOBILE_CLOSE_PALLET
  | typeof OPERATOR_MOBILE_REOPEN_PALLET
  | typeof OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW
  | typeof OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW;

const KEY_SET = new Set<string>([
  OPERATOR_MOBILE_MOVE_BOX,
  OPERATOR_MOBILE_VOID_BOX,
  OPERATOR_MOBILE_RESET_ENTRY,
  OPERATOR_MOBILE_EDIT_ITEM,
  OPERATOR_MOBILE_DELETE_ITEM,
  OPERATOR_MOBILE_CLOSE_PALLET,
  OPERATOR_MOBILE_REOPEN_PALLET,
  OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW,
  OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW,
]);

export function isOperatorMobilePermissionKey(v: string): v is OperatorMobilePermissionKey {
  return KEY_SET.has(v);
}

export const OPERATOR_MOBILE_PERMISSION_DENIED_MESSAGE =
  "You do not have permission to move or delete boxes.";

export const OPERATOR_MOBILE_EDIT_ITEM_DENIED_MESSAGE =
  "You do not have permission to edit scanned units.";

export const OPERATOR_MOBILE_DELETE_ITEM_DENIED_MESSAGE =
  "You do not have permission to delete scanned units.";

export const OPERATOR_MOBILE_DELETE_ORG_MISMATCH_MESSAGE =
  "Scanned item not found for this organization.";

export const OPERATOR_MOBILE_DELETE_NOT_SCANNED_UNIT_MESSAGE =
  "Not an operator mobile scanned unit for this box.";

export const OPERATOR_MOBILE_DELETE_OWNERSHIP_MESSAGE =
  "You can only delete scanned units you created.";

export const OPERATOR_MOBILE_CLOSE_PALLET_DENIED_MESSAGE =
  "You do not have permission to close pallets.";

export const OPERATOR_MOBILE_REOPEN_PALLET_DENIED_MESSAGE =
  "You do not have permission to reopen closed pallets.";

export const OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW_DENIED_MESSAGE =
  "You do not have permission to close shipment warehouse receive review.";

export const OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW_DENIED_MESSAGE =
  "You do not have permission to reopen shipment warehouse receive review.";
