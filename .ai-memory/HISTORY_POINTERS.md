# History pointers — authoritative

Do not paste full history into `.ai-memory`.

**Restore order:** V182 canonical → V183–V189 → V190 milestone → V191 item resolver + view alignment → V191 AFI guarded Tier 3 execute → V192 product resolution contract lock → **V192 expected_packages E1 plan append (latest)**.

---

## Latest operator history — V192 expected_packages E1 plan

```
.cursor/audit-reports/history-v191/20260526T120000Z/ERP_PIM_FULL_HISTORY_V191_APPEND_ONLY_ITEM_ADD_EDIT_RESOLVER_STANDARD.md
```

| Field | Value |
|-------|-------|
| Pack / run | `expected-packages-e1-map-bridge-plan-v192` / `20260521T013000Z` |
| Milestone | Expected_packages E1 map-only bridge preflight + approval plan |
| Base | V190 file + prior V191 appends + AFI execute append + V192 contract append + E1 plan append |

---

## Canonical base — V182

```
.cursor/audit-reports/history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md
```

---

## Milestone audit evidence

| Area | Path |
|------|------|
| V191 operator item resolver | `operator-item-add-edit-resolver-standard-v191/20260520T235500Z/` |
| V191 inventory read alignment | `inventory-expected-return-product-id-view-alignment-v191/20260521T001108Z/` |
| V191 expected_packages plan | `expected-packages-product-spine-completion-plan-v191/20260521T001400Z/` |
| V191 AFI rebase / guarded Tier 3 | `product-catalog-afi-rebase-next-batch-v191/20260521T002400Z/` · `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T003300Z/` |
| V191 AFI guarded Tier 3 execute | `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T010000Z/` |
| V191 Neda final backend handoff | `neda-final-backend-handoff-v191/20260521T004000Z/` |
| V192 product resolution contract lock | `backend-product-resolution-contract-lock-v192/20260521T012000Z/` |
| V192 expected_packages E1 map bridge plan | `expected-packages-e1-map-bridge-plan-v192/20260521T013000Z/` |
| V190 return_items / Preview closure | `history-v190/20260525T120000Z/` |
| V189 staging/original views | `inventory-views-return-items-deleted-at-filter-v189/` |
| Final proof V189 | `return-items-product-linkage-final-proof-v189/20260524T130000Z/` |

---

## Read order

| Need | Read |
|------|------|
| Now | `.ai-memory/CURRENT_STATE.md` |
| Neda | `.ai-memory/NEDA_HANDOFF.md` |
| DB | `.ai-memory/DATABASE_CONTRACT.md` |
| Product IDs | `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` |
| History | V191 path above |
| Sync pack | `history-memory-after-v191-item-resolver/20260526T120000Z/` |

---

## Paired-update law

History append + `.ai-memory` in one session.
