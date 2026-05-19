# History append — mandatory sections (V162)

Use this template for **every** new `ERP_PIM_FULL_HISTORY_V###_APPEND_ONLY_*.md` append block.
**Append only** — never delete or shorten prior content.

Replace `V###`, dates, and table rows from latest audit packs before writing.

---

## Section checklist (all required)

1. **AUTHORITATIVE CURRENT STATE** — one-paragraph + bullet facts
2. **ENVIRONMENT TOPOLOGY** — ASCII diagram: original / staging / production
3. **ACTIVE DATABASE REFS** — table with refs + env key names
4. **CURRENT APP TARGET** — must state original-only until ENV-05/06
5. **STAGING STATUS** — empty | cloning | cloned | verified
6. **PRODUCTION STATUS** — NOT_CREATED_YET + blocked flags
7. **PROMPT EXECUTION LEDGER** — recent prompts with run_id + PASS/FAIL/DONE
8. **PASS / FAIL / BLOCKED TABLE** — gates
9. **EXACT NEXT PROMPT ORDER** — numbered list
10. **FORBIDDEN ACTIONS** — see mandatory list below
11. **NEXT-CHAT HANDOFF** — exact boilerplate + order + blockers + passed + blocked
12. **CURRENT BLOCKERS** — table
13. **CURRENT PHASE** — name + sub-phase table
14. **SCANNER STATE** — NEDA ladder + package_items rule
15. **CLAIM STATE** — evidence workflow status
16. **ENVIRONMENT STATE** — policy, tools, PRODUCTION_*
17. **MIGRATION STATE** — count, staging apply status, clone method
18. **APP/VERCEL STATE** — cutover status
19. **WHAT MUST NOT CHANGE** — bullets
20. **WHAT IS SAFE TO CHANGE** — bullets

---

## Mandatory topology (always verbatim refs)

```
Original/current DB:     kxsvedvpjldygtdbylsy
Candidate staging DB:    eiqfaapyumhixxoeltgu
Production:              NOT_CREATED_YET
App target:              original DB only (until ENV-05/06 approval)
```

---

## Mandatory forbidden actions (always include)

- Do not create `package_items`
- Do not run production probes
- Do not switch app to staging before ENV-05/06
- Do not blindly run migrations on staging as clone substitute
- Do not create products from OCR/title without authority workflow
- Do not touch production

---

## Mandatory next-chat handoff (exact opener)

```
IF A NEW CHAT TAKES OVER:
THIS IS THE AUTHORITATIVE CURRENT STATE.
DO NOT REINTERPRET OLD STATES.
START FROM THE NEXT PROMPT ORDER BELOW.
```

Then include:
- exact next order
- current blockers
- what already passed
- what remains blocked

---

## End marker

```
================================================================================
END V### APPEND — HANDOFF FOR NEW CHAT
================================================================================
```

---

## Generator

Run prompt: `.cursor/prompts/CURSOR_PROMPT_GENERATE_HISTORY_V162.md`
