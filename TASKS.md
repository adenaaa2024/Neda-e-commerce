# Tasks — active board (V178)

Synced with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md).  
**Canonical history:** [`.ai-memory/HISTORY_POINTERS.md`](.ai-memory/HISTORY_POINTERS.md) → history-v178.

## P0 — Policy

- [ ] **Do not** register production or point Vercel Production at staging.
- [ ] **Do not** enable live AI (`AI_EXTERNAL_HTTP_ENABLED` + surface flags) without governance.

## P1 — Claims (staging)

- [ ] **Claim upstream blockers V177 execute** (governed) — `claim-upstream-blockers-v177/20260524T160000Z/` — **no blind** execute of 2,557 dry-eligible.
- [ ] **Candidate orphan FK charter** (~4,736) — separate from closed V176.
- [ ] TRID read OK; filing/submit only with operator approval.

## P2 — Product mapping

- [ ] **Next wave / ledger** — partial but operational; governed only; no blind settlements.
- [ ] `slip_contents` / transactions — strategy TBD.

## P3 — Neda / AI / roadmap

- [ ] **NEDA-PREVIEW-REGRESSION-PACK** (optional UI regression on Preview).
- [ ] **AI-LAYER-GATEWAY-03** (flags stay default deny).
- [ ] **RETURN-ITEMS-PROD-DATA-CHARTER** before returns volume KPIs.
- [ ] **HISTORY-V179+** append when next milestone closes.

## Done

- [x] **NEDA V178 handoff** — backend contract consumable; UI connector PASS
- [x] **AI gates** — `lib/ai-provider-gates.ts` default **deny**
- [x] Hardening roadmap V177 + AI plan V177 artifacts
- [x] V176 closeout; V175 resolver; wave-2 V176 mapping
- [x] Preview signoff; NEDA 15; schema smoke; storage 144/144; build PASS
- [x] Claims **72.7%** / drafts **51.5%** (live); safe unresolved/ambiguous UI labels

## Forbidden

[`.ai-memory/FORBIDDEN_ACTIONS.md`](.ai-memory/FORBIDDEN_ACTIONS.md) — no `package_items`, no `.from("returns")`, no production, no browser Supabase linkage writes, no OCR/title product auto-create, no live AI by default.
