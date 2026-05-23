# Validation results

| Area | Result | Notes |
|------|--------|-------|
| Scan speed / wedge focus | Pass with friction | Items phase keeps laser active during `busy`; gate/box phases block wedge while resolving |
| Hydration timing | Pass with friction | Stale-guard on pallet hydrate; post-save nonce refetch for counts; no slip-list loading affordance |
| Mismatch states | Pass with gap | Badges on identify gate + expected inventory rows; not on item-phase slip cards |
| Barcode fallback UX | Pass | Unknown modal, manual entry, help popover, ambiguous pickers, unexpected-item confirm |
| Expiry flow | Pass | `ItemUnitRecordModal` + tag/perishable heuristic; legacy `itemDraft` path still present |
| Unknown-product flow | Pass | Resolver unknown → modal; optional create-unknown-box; unexpected slip miss path |
| Slip matching visibility | Pass with friction | Qty progress clear; Awaiting state very subtle; over-scan warning only on list |
| DB / resolver / env | Not touched | Review-only run |

**Overall:** Stabilized flow is operable. Friction is mostly discoverability, timing feedback, and mismatch visibility during item scan—not data-layer blockers.
