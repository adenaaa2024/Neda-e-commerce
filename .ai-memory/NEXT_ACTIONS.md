# Next actions — canonical

**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-05-28 (`original-parity-wave-data-resolver-finish-verify` `20260528T220000Z`)

---

## P0 — Build / deploy gate

1. **BUILD-FIX-TESSERACT-SCAN-PAGE** — `npm run build` fails on missing `tesseract.js` in `app/scanner/operator-mobile/scan/page.tsx`; fix before deploy/merge  

---

## P1 — Original parity (post data wave)

2. **ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE** — governed map replays on original (E1/E2/E1B/PC03B) to reduce **2,413** `missing_product_needs_evidence`  
3. **ORIGINAL-PARITY-PHASE1-WAVE-C-EXECUTE** — scanner contract verification on original  

---

## Done — original data wave

- [x] **ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE** — `20260528T201200Z/` — fetch, sync, rebuild, resolver  
- [x] **ORIGINAL-PARITY-WAVE-DATA-RESOLVER-FINISH-VERIFY** — `20260528T220000Z/` — resolver complete **yes**; live **9,377 / 11,790** resolved  

---

## P2 — Claims / TRID schema apply

3. **CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY** — staging; migration drafted; dry-run **PASS**; ~**13,966** upper bound pre-dedupe  
4. **TRID-FOUNDATION-MIGRATION-APPLY** — after `claim_lines` prerequisite landed (`trid-foundation-migration-approval.md`)

---

## P2 — Branch delivery

5. **GH-AUTH-PR-CREATE** — open PR `feature/product-canonicalization-v2` → `main` for commit `51bc597`  
   - Compare: `https://github.com/mebrahimipargoo/ecommerce-os/compare/main...feature/product-canonicalization-v2`

---

## Done — phase1 delivery

- [x] Commit `51bc597` pushed — item-level scanner receive allocation repair  
- [x] Original schema wave **4/4** migrations PASS on original  
- [x] Staging EP **6,099 / 6,175** resolved  
- [x] Neda item-level smoke **PASS** after sync  
- [x] Claim lines schema dry-run **PASS**  
- [x] TRID foundation migration dry-run **PASS_WITH_BLOCKERS** (claim_lines prerequisite)  

---

## Blocked

- Deploy — until **BUILD-FIX-TESSERACT-SCAN-PAGE**  
- TRID apply — until **claim_lines** schema applied  
- Future production — **NOT_CREATED_YET**  
- Original production-ready — **NO** until Wave B/C + build fix; data wave resolver **complete**  
