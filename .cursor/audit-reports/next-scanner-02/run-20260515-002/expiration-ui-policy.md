# Expiration UI policy

## Current codebase

- There is **no** `products.requires_expiration_date` (or similar) column in migrations reviewed for this pass.
- Existing scanner / receive flows already collect `expiration_date` on `return_items` when the operator provides it (`ReturnInsertPayload.expiration_date`).

## Policy (aligned with prompt)

1. **When** a canonical product row eventually exposes `requires_expiration_date === true`, the scanner should prompt for expiration (reuse existing expiration capture UX).
2. **When** explicitly `false`, do not add new expiration prompts beyond existing flows.
3. **When** product is unknown / unresolved, keep current behavior: rely on existing condition-driven / operator-driven capture rather than inferring expiration obligation from OCR text.
4. **Do not** infer expiration requirement from OCR or slip description alone except as an explicitly low-confidence UX hint in a future dedicated task (not implemented here).

## This run

No change to expiration prompts; linkage work does not alter expiration validation.
