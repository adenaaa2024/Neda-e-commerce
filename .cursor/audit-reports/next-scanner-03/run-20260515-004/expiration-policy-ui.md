# Expiration policy — UI (this run)

Aligned with `.cursor/audit-reports/next-scanner-02/run-20260515-002/expiration-ui-policy.md`:

- **No change** to expiration prompts, validation, or FEFO helpers in the returns UI.
- Product linkage review panels do **not** infer expiration requirements from resolution status, mismatch, or OCR.
- Existing `expiration_date` capture on receive (`ReturnInsertPayload`) remains the sole scanner-related expiration path touched indirectly (unchanged).

Future work (out of scope): when a canonical `products.requires_expiration_date` exists, gate expiration UX off that flag as described in the NEXT-SCANNER-02 policy doc.
