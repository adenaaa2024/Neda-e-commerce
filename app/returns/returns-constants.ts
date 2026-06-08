/**
 * PostgREST selectors for `return_items` (scanner line items), `packages`, and `pallets`.
 * Package/pallet column lists match staging DB — see `lib/package-pallet-canonical.ts`.
 * Lives outside `actions.ts` because `"use server"` modules may only export async functions (Next.js 16+).
 *
 * PERFORMANCE NOTE: Embedded aggregate counts like `return_items(count)` and `packages(count)` are
 * executed by PostgREST as correlated subqueries (one per row) and will cause statement timeouts
 * on any non-trivial dataset.  Instead we rely on the denormalised count columns that are already
 * maintained by the DB (`actual_item_count` on packages, `item_count` on pallets).
 */

export {
  PACKAGE_LIST_SELECT,
  PACKAGE_MUTATION_SELECT,
  PALLET_LIST_SELECT,
  PALLET_MUTATION_SELECT,
} from "../../lib/package-pallet-canonical";

/** PostgREST table name for scanner / warehouse operational line items (renamed from `returns`). */
export const RETURN_ITEMS_TABLE = "return_items";

/** `return_items` rows with store embed (FK `store_id` → `stores`) — used for insert/update/detail. */
export const RETURN_SELECT = "*,stores(name,platform)";

/**
 * List/detail reads for the Items tab — explicit columns + single `stores` embed (no `*`).
 * Avoids PostgREST edge cases where `*` plus embeds can fan out duplicate parent rows.
 */
export const RETURN_LIST_SELECT =
  "id, organization_id, lpn, rma_number, marketplace, item_name, " +
  "asin, fnsku, sku, product_identifier, " +
  "conditions, status, notes, photo_evidence, " +
  "expiration_date, batch_number, scanned_quantity, store_id, pallet_id, package_id, expected_item_id, " +
  "order_id, " +
  // Omit legacy `product_id` here — not added in all migration paths; detail/update use `RETURN_SELECT` (`*`).
  "resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence, " +
  "created_by, updated_by, created_at, updated_at, estimated_value, deleted_at, " +
  "stores(name,platform)";

/**
 * Scanner product-linkage columns shared by `return_items` and `slip_contents` reads.
 * Keep this selector narrow; not every scanner path can safely select legacy item columns.
 */
export const RETURN_SCANNER_LINKAGE_SELECT =
  "resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence";

export const SLIP_SCANNER_LINKAGE_SELECT = RETURN_SCANNER_LINKAGE_SELECT;

/**
 * Same shape as `RETURN_SELECT`, for `claim_submissions` → `return_items` FK embeds:
 * `select('*, return_items(' + RETURN_SELECT + ')')`
 */
export const RETURNS_EMBED_SELECTOR = RETURN_SELECT;
