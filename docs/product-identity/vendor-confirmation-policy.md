# Vendor confirmation policy (imports / API)

<!-- markdownlint-disable MD013 MD060 -->

**Slice:** NEXT-PRODUCT-ID-04 (policy text; no vendor tables, no AI in this slice)

---

## Goals

- Never silently corrupt vendor identity on ingest.
- Preserve **raw** vendor strings from files and APIs.
- Allow known-good literals without treating every numeric string as valid.

---

## Explicit allowlist

- **`1883`** is a **valid vendor** identifier and must **not** be flagged solely for being numeric-looking.

---

## Other values (numeric-looking or suspicious)

For vendor values **other than** the explicit allowlist (including other bare-numeric strings):

1. **Preserve** the raw value on the row / payload (do not overwrite with guesses).
2. **Classify** as `needs_confirmation` or `review_required` in validation output (when the pipeline supports those states).
3. **Operator confirmation** — org- or store-scoped where relevant — before treating the vendor as trusted for downstream joins.
4. **Future AI / search** (when entitled and implemented): may research whether a vendor exists; may accept only with **stored evidence** (source URL, snapshot id, etc.). If not confident, keep in review.
5. **Future vendor alias / identity map** may remember approved `(organization_id, store_id?, raw_vendor) -> canonical_vendor` mappings — **not implemented** in this slice.

---

## Forbidden in this slice

- Implementing vendor dimension tables.
- Calling AI / web search at runtime.
- Hard-failing imports solely because vendor is numeric unless policy explicitly excludes that value and allowlist does not cover it.

---

## Relation to product identity

Vendor confirmation is orthogonal to `product_id` / `resolved_product_id`, but shared import pipelines should apply this policy so **operational** rows are not blocked incorrectly while **identity** work proceeds separately.
