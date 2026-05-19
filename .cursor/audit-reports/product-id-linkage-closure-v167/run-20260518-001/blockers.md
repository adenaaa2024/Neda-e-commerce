# Blockers

## B1 — Migration `20260717120000` not fully applied (HIGH)

**Impact:** Missing `identifier_resolution_source`, `expected_packages` product FKs, slip `parsed_*` / OCR columns. Enrichment and manual override cannot persist full payloads; extended EP selects fail.

**Action:** Operator-approved apply on staging → verify → production per existing scanner runbooks.

---

## B2 — `identifier_resolution_source` absent on `return_items` / `slip_contents` (MEDIUM)

**Impact:** Manual override and enrichment log warnings; UI cannot distinguish `manual_override` vs automatic match when only status/confidence exist.

**Action:** Resolved by B1 (same migration).

---

## B3 — `v_product_identity` not on staging (LOW)

**Impact:** REST consumers cannot query unified identity view; does not block scanner receive path.

**Action:** Separate approval for `20260630_v_product_identity.sql`.

---

## B4 — Staging data: no resolved `slip_contents`; recent `return_items` smoke unresolved (MEDIUM)

**Impact:** Cannot sign off end-to-end linkage with live resolved rows on current fixtures.

**Action:** After B1, re-run operator smoke with FNSKU known in `product_identifier_map` for test org/store.

---

## Non-blockers (confirmed)

- `expected_packages` without product FK — **intentional** until migration.
- Legacy `return_items.product_id` often null — app uses `resolved_product_id` path.
- `claim_reference_edges` without denormalized `product_id` — graph model by design.
