# History append — mandatory sections (V163)

**Supersedes:** `history-append-mandatory-sections-v162.md` (20 sections) → **22 sections**.

Use for every new `ERP_PIM_FULL_HISTORY_*_APPEND_ONLY_*.md` append. **Append only.**

---

## Section checklist (all 22 required)

1. **AUTHORITATIVE CURRENT STATE**
2. **EXACT ENVIRONMENT TOPOLOGY**
3. **ACTIVE DATABASE REFS**
4. **CURRENT APP TARGET**
5. **CURRENT STAGING TARGET**
6. **PRODUCTION STATUS**
7. **PROMPT EXECUTION LEDGER**
8. **PASS / FAIL / BLOCKED TABLE**
9. **EXACT NEXT PROMPT ORDER**
10. **FORBIDDEN ACTIONS**
11. **NEXT-CHAT HANDOFF**
12. **CURRENT BLOCKERS**
13. **CURRENT PHASE**
14. **SCANNER STATE**
15. **CLAIM STATE**
16. **PRODUCT/PIM STATE**
17. **IMPORT STATE**
18. **ENVIRONMENT STATE**
19. **MIGRATION STATE**
20. **APP/VERCEL STATE**
21. **SAFE-TO-CHANGE LIST**
22. **MUST-NOT-CHANGE LIST**

---

## Mandatory environment topology (verbatim refs)

```
Original/current DB:     kxsvedvpjldygtdbylsy
Candidate staging DB:    eiqfaapyumhixxoeltgu
Production:              NOT_CREATED_YET
App target:              original DB until ENV-05/06 PASS
```

---

## Mandatory forbidden actions

- Do not create `package_items`
- Do not run production probes
- Do not switch app to staging before ENV-05/06
- Do not blindly run migrations
- Do not create products from OCR/title
- Do not touch production

---

## Mandatory next-chat handoff (exact opener)

```
IF A NEW CHAT TAKES OVER:
THIS IS THE AUTHORITATIVE CURRENT STATE.
DO NOT REINTERPRET OLD STATES.
START FROM THE NEXT PROMPT ORDER BELOW.
```

Then: exact next order · current blockers · what already passed · what remains blocked

---

## Generator

`.cursor/prompts/CURSOR_PROMPT_GENERATE_HISTORY_V163.md`
