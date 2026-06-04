/**
 * Flat permission keys for operator mobile correction actions (Platform Access catalog).
 * Synced via `lib/sidebar-catalog-extras.ts` → `npm run sync:sidebar`.
 */

export const OPERATOR_MOBILE_MOVE_BOX = "operations.operator_mobile.move_box" as const;
export const OPERATOR_MOBILE_VOID_BOX = "operations.operator_mobile.void_box" as const;
export const OPERATOR_MOBILE_RESET_ENTRY = "operations.operator_mobile.reset_entry" as const;
export const OPERATOR_MOBILE_EDIT_ITEM = "operations.operator_mobile.edit_item" as const;
export const OPERATOR_MOBILE_DELETE_ITEM = "operations.operator_mobile.delete_item" as const;

export type OperatorMobilePermissionKey =
  | typeof OPERATOR_MOBILE_MOVE_BOX
  | typeof OPERATOR_MOBILE_VOID_BOX
  | typeof OPERATOR_MOBILE_RESET_ENTRY
  | typeof OPERATOR_MOBILE_EDIT_ITEM
  | typeof OPERATOR_MOBILE_DELETE_ITEM;

const KEY_SET = new Set<string>([
  OPERATOR_MOBILE_MOVE_BOX,
  OPERATOR_MOBILE_VOID_BOX,
  OPERATOR_MOBILE_RESET_ENTRY,
  OPERATOR_MOBILE_EDIT_ITEM,
  OPERATOR_MOBILE_DELETE_ITEM,
]);

export function isOperatorMobilePermissionKey(v: string): v is OperatorMobilePermissionKey {
  return KEY_SET.has(v);
}

export const OPERATOR_MOBILE_PERMISSION_DENIED_MESSAGE =
  "You do not have permission to move or delete boxes.";
