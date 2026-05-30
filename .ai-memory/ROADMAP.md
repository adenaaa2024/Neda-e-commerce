# Roadmap — ERP/PIM program

**Branch:** `feature/product-canonicalization-v2`  
**Last updated:** 2026-05-26 (canonical memory rebuild)

## Priority order (authoritative)

| # | Phase | Focus | Status |
|---|-------|-------|--------|
| 1 | **Canonical product linkage** | `products` + `product_identifier_map` + `resolved_product_id`; expected/slip/return/AFI waves | **In progress** — PC01–PC03B done; 43 EP unresolved |
| 2 | **Expected / source cleanup** | Dirty-source quarantine (38), disagreement map, manual 404 queue (5) | **Planned** — PC03/PC07 plans PASS; execute approval-gated |
| 3 | **Controlled SP-API evidence** | Catalog evidence only; no uncontrolled product creation | **Blocked** — env ready; approval **false** |
| 4 | **Packaging schema** | Versioned profiles + dimensions | **DDL applied** both refs; backfill **staging only** (191) |
| 5 | **Claims engine** | Census, cleanup waves, materialize — no live repoint yet | **Dry-run / staging cleanup only** |
| 6 | **AI layer** | Import/OCR/assistant surfaces | **Later** — default deny |

## Near-term prompts (ordered)

1. **PC06A** — COMMIT OPERATOR-ONLY DDL TO SUPABASE MIGRATIONS  
2. **PC07-EXEC** — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE (38 rows; approval)  
3. **PC07** — ORIGINAL SPINE DML PARITY PLAN (13 waves; no UUID copy)  
4. **PC02C** — operator ASIN correction for 5 API-404 rows  
5. **CLAIM-CLEANUP** — Wave B source orphan + original parity replay (V203–V207 pattern)  
6. **PC02** — SP-API evidence execute (after `APPROVED_SP_API_EVIDENCE_DRY_RUN=true`)  
7. **return_items / slip_contents** canonicalization waves (after expected_packages stable)

## Completed anchors (do not re-litigate)

- V182 canonical history rebuild  
- V189 return_items test-cohort closure (staging)  
- V192 product resolution contract lock  
- V193–V196 lookup + inventory product columns  
- V205/V206 `package_code` views (staging + original)  
- PC04 packaging DDL + PC05C staging backfill  
- PC05 claim census  

## Out of scope until explicit charter

- Future production project registration / cutover  
- Live claim filing / submit  
- Blind bulk resolver execute  
- AI/OpenAI product resolution  
- Browser Amazon / SP-API calls  

## Checkpoint

**Current phase:** PC Phase 01 closeout → entering **PC06A / PC07** (migrations commit + original DML parity + dirty-source execute).  
**North star:** One deterministic product spine across scanner, expected packages, claims, and packaging — with staging-first proofs and original parity by re-run, not UUID copy.

See [NEXT_ACTIONS.md](NEXT_ACTIONS.md) and master history §14–16.

---

## Current program priority — June 2026 (append; authoritative for active work)

**Platform:** Monorix · **Index:** [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md)

| # | Track | Focus | Status |
|---|-------|-------|--------|
| **1** | **Scanner completion** | Item-level receive (`51bc597`); build fix; Wave C on original; PR/merge | Build **BLOCKED**; smoke **PASS** |
| **2** | **Product completion** | Original EP resolver gap **2,413**; Wave B map replays | Staging **6,099/6,175** |
| **3** | **Removal API completion** | SP-API pipeline; rebuild; cron automation | Data wave **DONE** both refs |
| **4** | **Claims** | `claim_lines` apply → backfill → `claim_case_evidence` schema | Drafted; **not applied** |
| **5** | **TRID** | Foundation after `claim_lines` | Dry-run **PASS_WITH_BLOCKERS** |
| **6** | **Inventory** | `v_inventory_item_status` / `package_code` parity | Applied staging + original |
| **7** | **AI layer** | Assistants / OCR / import GPT | **Later** — default deny |

**Continuity:** PC Phase 01 table above remains historical anchor — phase1 delivery superseded staging EP counts; **do not delete** PC rows.

**Immediate next:** BUILD-FIX-TESSERACT-SCAN-PAGE → ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE → CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY → GH-AUTH-PR-CREATE

**Last updated (append):** 2026-06-06
