# Blocked tasks — NEDA-19

Tasks Neda should **not** start until the blocker clears. None of these require resolver logic changes.

---

## BLK-1 — Operator manual product link (read path missing)

| Field | Detail |
|-------|--------|
| **Symptom** | `manualOverrideReturnItemProductResolution` exists and works from **returns admin** UI only; operator-mobile has no product picker/search |
| **Blocks** | Manual review sheet from **Needs review** / **No product link yet** chips; **Link product** on `ItemUnitRecordModal` |
| **Owner** | Engineering (small server action) — not Neda migration |
| **Unblock** | Add `searchOperatorProductsForStoreAction(orgId, storeId, query)` returning existing `products.id` rows (org+store scoped, read-only) |
| **Neda may do after unblock** | UI sheet calling existing `manualOverrideReturnItemProductResolution` — still no `products.insert` |

**Workaround today:** Operators use desktop returns drawer for override.

---

## BLK-2 — Ambiguous linkage staging fixture

| Field | Detail |
|-------|--------|
| **Symptom** | Cohort: 3 active `return_items`, 3 resolved, **0 unresolved/ambiguous** — browser never proved **Needs review** chip on operator-mobile |
| **Blocks** | UI-H7 visual QA, tooltip copy signoff for ambiguous state |
| **Unblock** | Seed one `return_items` row with `identifier_resolution_status = 'ambiguous'` on SAM store **or** use fixture org package after data team seeds |
| **Safe without seed** | Unit-level static test of `OperatorProductLinkageMeta` with mock `ProductLinkageDisplayContract` (optional) |

Do **not** fix by changing resolver or auto-creating products.

---

## BLK-3 — Browser direct write on scan page (contract violation)

| Field | Detail |
|-------|--------|
| **Symptom** | `neda-final-runtime-replay-after-v189` reports `browser_direct_writes_on_scan_page: 1` — `supabase.from("pallets").insert` in `ensureShipmentReceivingPallet` |
| **Blocks** | Claiming full v165 “no browser writes” compliance |
| **Unblock** | **UI-C3** — route through `createOperatorPalletAction` (action already imported) |
| **Note** | Not a migration; same table, approved server path |

---

## BLK-4 — EP product resolution columns on staging

| Field | Detail |
|-------|--------|
| **Symptom** | `expected_packages` has no `identifier_resolution_*` on staging; extended EP select 42703-fallbacks |
| **Blocks** | Reading EP resolution badges from DB columns; `db_ep_linkage_select` probes |
| **Unblock** | Operator-approved migration apply `20260717120000` — **out of Neda agent scope** |
| **Neda continues** | `buildExpectedPackageProductLinkage` + SKU/FNSKU display (current PASS path) |

---

## BLK-5 — Client catalog query on item draft (forbidden pattern)

| Field | Detail |
|-------|--------|
| **Symptom** | `populateDraftFromEpRow` uses `supabase.from("products").select("*")` by barcode |
| **Blocks** | V178 “no client catalog queries” strict signoff |
| **Unblock** | **UI-C4** — use EP line `product_linkage` for name/image/expiry hints, or add thin server read action |
| **Related** | Not blocked for operator function—blocked for contract hygiene PR |

---

## BLK-6 — Additive fields for mismatch-on-slip (deferred UI-D1)

| Field | Detail |
|-------|--------|
| **Symptom** | Slip cards cannot show persisted `product_match_status` / review flags per unit |
| **Blocks** | Per-slip “catalog mismatch” badge without client re-derive |
| **Unblock** | Additive fields on `listOperatorPackageItemsForPackageAction` select + aggregate (no migration if columns exist on `return_items`) |
| **Policy** | Separate PR from NEDA-19 UI polish |

---

## BLK-7 — Production / Amazon / AI

| Constraint | Status |
|------------|--------|
| Production DB | Forbidden |
| Migrations from Neda agent | Forbidden |
| Amazon SP-API | Forbidden |
| OpenAI / new OCR | Forbidden |

---

## Summary table

| Blocker | Severity | Neda action |
|---------|----------|-------------|
| BLK-1 Product search | High for manual review | Wait / pair with eng |
| BLK-2 Ambiguous fixture | Medium for QA | UI mock or seed request |
| BLK-3 Pallet client insert | High for compliance | **UI-C3** (Neda can fix) |
| BLK-4 EP migration | Low | Continue fallback display |
| BLK-5 Products client select | Medium | **UI-C4** |
| BLK-6 match status select | Low | Defer |
| BLK-7 env/policy | Hard | Never |
