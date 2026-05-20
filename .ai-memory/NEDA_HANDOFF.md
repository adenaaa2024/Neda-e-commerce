# Neda handoff — V183+

**Staging / Preview only.** Production **blocked**.

## Environment (mandatory)

| Rule | Value |
|------|--------|
| **Active Supabase ref** | **`eiqfaapyumhixxoeltgu`** (staging) |
| V183 status | **PASS / ALIGNED** |
| **If active quartet → original** | **STOP** — **top blocker** (ENV-05E) |
| Vercel Production | `kxsvedvpjldygtdbylsy` — not for Neda work |

Verify `NEXT_PUBLIC_SUPABASE_URL` matches staging before each session.

## V181 signoff — expected + inventory

| Item | Status |
|------|--------|
| Audit | `expected-inventory-neda-read-model-signoff-v181/20260521T120000Z/` |
| Overall | **PASS** |
| Paths | `fetchExpectedPackagesNedaRead`, `fetchInventoryItemStatusForNeda` |
| `package_items` | absent **PASS** |

## Inventory views (V179 contract)

| View | Product linkage? |
|------|------------------|
| **`v_inventory_item_status`** | **YES — only** → `fetchInventoryItemStatusForNeda` |
| `v_inventory_status` | **NO** — package aggregate chip only |
| `v_scanned_items_counted` | **NO** — counters only (V189 adds `deleted_at` filter on later staging) |

## Product linkage (V178)

- `ProductLinkageDisplayContract` + `ProductLinkageDisplayBlock`
- Approved server actions only — **no direct browser Supabase** writes for linkage/catalog

## Required rules

1. Contract-only product display — no title/OCR inference.
2. **No** `.from("returns")` — **`return_items`** only.
3. **No** `package_items`.
4. Unresolved → **No product link yet**; ambiguous → **Needs review**.

## `return_items` warning (V183 baseline)

At V183 dry-run: **~7** staging rows — **fake/test** — not KPI truth; **5** unresolved; FBM execute **blocked** (0 `set_resolved`).

**Later (V186–V189):** test cohort quarantined/resolved on staging — see `history-v189/` for current active counts (3 resolved, 4 soft-deleted).

## Status

| Gate | Status |
|------|--------|
| V181 read signoff | **PASS** |
| V179 inventory/expected | **PASS** |
| Neda env staging | **ALIGNED** (monitor drift) |
| Production | **Do not use** |

## Context

- `.ai-memory/CURRENT_STATE.md`
- [HISTORY_POINTERS.md](HISTORY_POINTERS.md)
