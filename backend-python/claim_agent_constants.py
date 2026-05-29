"""Constants for claim agent — approved PostgREST embeds (no legacy ``returns`` join)."""

from __future__ import annotations

# Staging Supabase project ref — required before any agent DB/browser work.
STAGING_PROJECT_REF = "eiqfaapyumhixxoeltgu"

# Matches app/claim-engine/claim-submissions-constants.ts (return_items spine).
CLAIM_SUBMISSIONS_WITH_RETURN_ITEM = (
    "*, return_items(id, order_id, asin, fnsku, sku, lpn, item_name, package_id, pallet_id, "
    "resolved_product_id, stores(name,platform))"
)

CLAIM_LINES_SELECT = (
    "id, organization_id, return_item_id, claim_case_id, order_id, sku, fnsku, asin, status, line_grain"
)
