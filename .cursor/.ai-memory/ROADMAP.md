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

**Last updated (append):** 2026-06-11 (`phase1-roadmap-and-history-memory-update` `20260611T120000Z`)

---

## Phase 1 program priority — authoritative (2026-06-11)

**Git:** `main` @ `4402064` · stash land `feature/phase1-latest-stash-land` @ `c78fbb8` — **not merged** (operator policy: no merge yet)

| # | Priority | Focus | Status |
|---|----------|-------|--------|
| **1** | **Product sheet / PIM** | Spreadsheet import pipeline + PIM normalization | **Needed** |
| **2** | **Claims returns-first** | Cutoff/scoping, data validation, manual grouping roadmap | In progress (cutoff on staging); grouping roadmap |
| **3** | **Product linkage census** | Remaining gaps — read-only census before execute | **Queued** |
| **4** | **Product update job** | Refresh-safe pause/resume/cancel/schedule | **Not implemented** |
| **5** | **Superadmin automation** | Removal + product sync scheduler settings | **Planned only** |
| **6** | **Removal historical fetch** | Nov–Dec split windows resume | Nov 1–7 done; later windows blocked |
| **7** | **Cron apply** | Rolling 7-day incremental sync | **Off** — enable only with approval |

### Done / do not re-block

- Removal rebuild allocation mismatch **fixed** staging — non-overflow **0**, duplicate EP groups **0** (**SUPERSEDED** prior PARTIAL burn-in)
- DB parity slip/view + product spine (staging + original) — **PASS** (prior executes)
- Item-level receive + allocation RPCs — **good**

### Branch policy

Do **not** merge `feature/phase1-latest-stash-land` → `main` until operator explicitly approves. Stash land holds claim cutoff gates, delete/undo wiring, receive delete-release tests.

**Continuity:** PC Phase 01 and June 2026 tables above remain historical anchors — **do not delete**.

---

## Phase 1 dry-run results + execution policy (2026-06-12)

**Branch:** `feature/phase1-latest-stash-land` @ `c78fbb8` · **no merge** to main

### Product sheet dry-run (read-only)

| Bucket | Count |
|--------|------:|
| Total | **4479** |
| Safe null-fill | **2678** |
| Map candidates | **233** |
| Catalog candidates | **2779** |
| Specs | **32** |
| Blocked creates | **1700** |
| Needs-review / conflicts | **3399** |

**No broad import.** Next: **Phase F conflict resolution** -> **max-25 sample wave**.

### Expected linkage census (complete)

Class A = **2** staging · Class C **dominates** · `return_items` drift **2365** staging rows.

**SUPERSEDED:** linkage census "queued" — now **done**; governed sample only.

### Claims returns-first

Cutoff dates **unconfigured** · module scope **not implemented** · manual grouping UI **not built**.

### Product enrichment

Browser-loop update button — needs **backend job in waves**.

### Execution policy (authoritative)

`census -> classify -> sample dry-run -> approval -> sample apply -> verify -> next wave`

**Hard gates:** no merge · no cron apply · no original DB without explicit approval · no broad product import.

---

## Product Core protection (2026-06-13)

**Authoritative:** [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md)

| Rule | Detail |
|------|--------|
| Status | **Protected backbone** — no rewrite/simplify/bypass |
| Architecture completion | **90-95%** |
| Operational/data completion | **65-75%** |
| Change gate | audit + parity proof + risk report + operator approval |

**Exact next prompt:** `PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION`

---

## Architecture repair sync (2026-06-14)

**Authoritative:** [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

| Fact | Value |
|------|-------|
| Bulk/orphan RI hard-delete (staging) | **5333** removed — **COMPLETE** |
| Active `return_items` | **33** (`active_with_package` **3**, `bulk_orphan` **0**) |
| Spine unchanged | `products` **17033** · `expected_packages` **9459** / **9139** resolved · `product_identifier_map` **16811** |
| `v_scanned_sum` | **3** |
| Architecture | EP = forecast/API/removal; RI = physical scans only; no bulk RI; no EP→RI copy without proven scan |
| Product Core | **protected** (unchanged) |
| Merge to main | **NO** |

### P0 (ordered)

1. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**
2. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION**

**Exact next prompt:** `INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION`

---

## Phase1 pre-Neda merge sync (2026-06-16)

**Authoritative:** [AUTOMATION_API_CENTER.md](AUTOMATION_API_CENTER.md) · [CURRENT_STATE.md](CURRENT_STATE.md)

| Area | Status |
|------|--------|
| Automation API Center | Company/store scoped; type combo; one card; in-page selectors; **not** global top selector |
| Imports | File-import only; UniversalImporter + history remain; API routes reused by Automation |
| Vendor 1883 cleanup (staging) | **COMPLETE**; Product Hub warning fixed (effective vendor label) |
| Product sheet sample wave | **0 product creates** |
| Claims returns-first | Policy **on staging**; draft E2E needs closed package + evidence/note |
| Product Core | Protected — no resolver rewrite; governed seed only |
| Merge readiness | **NOT READY** — Phase1 final QA gate required |

### P0 before merge

1. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**
2. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE**
3. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**
4. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION**

**Exact next prompt:** `PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE`

---

## Phase1 demo-ready (2026-06-17)

**Authoritative:** [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md)

| Check | Status |
|-------|--------|
| Demo readiness | **READY** — Automation · Imports · scanner · Product Hub |
| Merge readiness | **NOT READY** — QA gate + claims E2E + operator approval |
| Delete/move/void backend | **COMPLETE** staging |
| Original DB DDL | **Separate approval** |

**Exact next prompt:** `PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE`
