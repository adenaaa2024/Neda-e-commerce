# Next actions — V196 closeout (carried forward to V202 proof)

See [TASKS.md](../TASKS.md).

---

## Done — V196/V197 (this closeout)

- [x] V196 item_name/UPC/ambiguous lookup fix **PASS** (code)
- [x] V196 expected API/manual plan **PASS** (V199 + V201 + API dry-run packs)
- [x] V196 vendor 1883 plan **PASS** (read-only)
- [x] V196 packaging model plan **PASS** (`packaging_level` + `fulfillment_context`)
- [x] V197 product linkage table census **PASS**
- [x] V198 E1B execute **BLOCKED** (documented; closed V200)
- [x] History V196 + memory sync `20260522T230000Z` **PASS**

## Done — subsequent (after V196)

- [x] V200 E1B materialize + E1B cohort closed
- [x] V202 / V200 browser proof **PASS** (11/11)
- [x] V195 original parity, V194/V193/V192 (carried)

- [x] V202 Amazon API evidence dry-run **READY_FOR_EXECUTE_REVIEW** (`20260522T200000Z`)
- [x] V202 Amazon API evidence execute **FAIL** — 3 real SP-API calls; catalog 404 US MP; 0 inserts (`20260522T210000Z`)
- [x] V202 identifier manual review batch **PASS** — 43 queued; 38 quarantine/fix source; 5 API 404 manual (`20260522T220000Z`)

---

## P1 — Next phase (claims / API / TRID / catalog)

1. **EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202** — 6 rows  
2. **EXPECTED-PACKAGES-DIRTY-TEST-QUARANTINE-V202** — optional; 38 rows need source identifier fix (UNKNOW / ASIN in FNSKU)  
3. **Claims** — governed cleanup / regeneration  
4. **API / TRID** — hardening after execute review  
5. **API 404 ASINs** — operator_verify_asin_or_manual_pim (5 rows in batch queue)  
6. **V196B vendor 1883** — allowlist + display name (governed)  
7. **PRODUCT-PACKAGING-DDL-STAGING-PLAN-V201** — approval-gated  

---

## Production (blocked)

Future production Supabase project **NOT_CREATED_YET**. Do not point Vercel Production at staging.
