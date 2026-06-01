# Product canonicalization — PC Phase 01

**Branch:** `feature/phase1-latest-stash-land` @ `999f765`  
**Last updated:** 2026-06-16 (`phase1-pre-neda-merge-history-memory-sync` `20260616T120000Z`)

## Product Core protection

**Product Core is protected backbone architecture** — see [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md).

Do not rewrite resolver, matching, merge, creation, normalization, or identifier-map flows without audit + parity proof + risk report + operator approval.

| Dimension | Completion |
|-----------|------------|
| Architecture | **90-95%** (**CLARIFIED**) |
| Operational / data | **65-75%** (**CLARIFIED**) |

Wave1 enrichment refactor: **SAFE** (code move only).

## Product sheet import dry-run (read-only)

| Bucket | Count |
|--------|------:|
| Total rows | **4479** |
| Safe null-fill | **2678** |
| Map candidates | **233** |
| Catalog candidates | **2779** |
| Specs | **32** |
| Blocked creates | **1700** |
| Needs-review / conflicts | **3399** |

**Policy:** **No broad product import.**  
**Next:** Phase F conflict resolution -> max-**25** sample wave.

## Expected linkage census (read-only — COMPLETE)

| Finding | Staging |
|---------|--------:|
| Class A | **2** |
| Class C | **dominates** |
| `return_items` drift | **2365** rows |

**SUPERSEDED:** "linkage gaps census needed" — census **done**; only governed Class A sample eligible.

## Product enrichment

Update button = **browser-loop** — must move to **backend job in waves** before scale.

## DB parity + product spine (prior — still valid)

Staging + original slip/view parity **PASS** · staging true linkage **PASS**.

## Spine

V192 contract · no title/OCR auto-create · map-only resolver paths · **do not redesign Product Core resolver** · **do not auto-create products except governed seed approvals** · **do not touch UniversalImporter file pipeline**.

---

## Vendor 1883 staging cleanup (2026-06-16)

| Item | Status |
|------|--------|
| `products.vendor_name` exact `1883` → `1883 Maison Routin` | **COMPLETE** |
| Remaining exact `vendor_name = 1883` | **0** |
| Product Hub vendor warnings | **Generic/data-driven** — effective vendor label (`vendor_id` / `vendors.name` / cache); not 1883-specific |

**SUPERSEDES:** V196 vendor 1883 plan-only memory.

---

## Product sheet sample wave (2026-06-16)

| Item | Status |
|------|--------|
| Sample wave apply | **PASS** — **0 product creates** |
| Broad import | **Still forbidden** — Phase F conflicts remain for full cohort |
