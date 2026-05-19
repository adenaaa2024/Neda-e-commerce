# Expected vs scanned mismatch — UI

## Data model (unchanged)

Mismatch is expressed on **`return_items`** as `product_match_status = 'mismatch'` and typically `product_review_required = true`, per NEXT-SCANNER-02 policy (expected product vs resolver product differ).

## UI surfacing

1. **Badges:** `scannerProductResolutionBadges` renders a **Mismatch** chip when `product_match_status === "mismatch"` (takes precedence in display order alongside identifier tier and review chip).
2. **Identification gate:** Expectation lines with non-empty linkage fields show per-line chips so operators see mismatch **before** starting the receive workflow.
3. **Returns item drawer:** The review panel appears for mismatch (even if other flags are absent), with manual override flow to pick an existing catalog product.

## Non-goals (this run)

- No new “expected vs scanned” matrix beyond existing slip/EP inspection surfaces.
- No auto-resolution of ambiguous identifier tiers.
