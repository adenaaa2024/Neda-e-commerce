# Next actions — canonical

**Branch:** `feature/phase1-latest-stash-land` @ `999f765` · **main** `4402064` (not merged)  
**Last updated:** 2026-06-17 (`phase1-demo-ready-history-memory-sync` `20260617T120000Z`)

**Demo checkpoint:** [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md)

---

## P0 — Pre-merge gates

1. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**  
2. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE** — `expected_group` + `import_source` remain **blocked**  

**Merge to main / Neda:** **NO** until P0 #1 + operator approval

---

## P1 — Non-demo-blocking

3. **INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION**  
4. **DELETE-CASCADE-UNDO-ORIGINAL-APPLY** — separate approval; staging PASS  
5. **DELETE-VOID-RESTORE-RPC-WIRING** — optional staging enhancement  
6. **PRODUCT-SHEET-IMPORT-PHASE-F-CONFLICT-RESOLUTION** — full cohort; sample wave done  

---

## Done — Phase1 demo-ready

- [x] Automation API Center **COMPLETE**  
- [x] Imports file-only **COMPLETE**  
- [x] Product Core no auto-create **ENFORCED**  
- [x] Vendor 1883 cleanup + generic warning architecture  
- [x] Scanner physical-only RI + product linkage preserved  
- [x] Delete / move / void backend parity **COMPLETE** (staging)  
- [x] Claims returns-first policy configured; non-returns grains blocked  
- [x] Product sheet sample wave — **0 creates**  

---

## Hard policy

| Rule | Value |
|------|-------|
| Neda merge | Preserve scanner UX + allocation/release rules |
| Original DB DDL | **Separate approval** |
| Product Core resolver rewrite | **FORBIDDEN** |
| Auto-create products | **Governed seed only** |
| Bulk RI from expected/API | **FORBIDDEN** |
