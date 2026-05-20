# Next actions — V178

See [TASKS.md](../TASKS.md). Order from history-v178 §9.

---

## 1. V176 final closeout

**DONE** — `PASS_CLOSED` (`claim-candidate-resolver-v176-final-verify-close/20260524T140000Z`).

---

## 2. Neda V178 handoff follow-through

**DONE (baseline):** Backend contract + UI connector **PASS**.

**Optional next:**

- **NEDA-PREVIEW-REGRESSION-PACK** — UI regression on Preview after connector changes.
- Contract-preserving UI polish only — no browser Supabase direct-writes; no OCR/title product inference.

---

## 3. Claim upstream blockers V177 (execute — governed)

~2,474 candidates / ~4,427 drafts open. **2,557** dry “eligible” — **do not blind execute**.

- Waves A/B/C per `claim-upstream-blockers-v177/20260524T160000Z/`
- Separate charter: ~4,736 candidate orphan FK (V175 legacy)

---

## 4. Product mapping next wave / Amazon ledger

- **Partial but operational** — continue governed waves only.
- Wave-3 / ledger: `product-id-mapping-wave-2-v176` or successor; **no** blind `amazon_settlements` bulk.
- `return_items` out of scope (test cohort).

---

## 5. Hardening roadmap artifacts

**DONE (V177 pack on disk)** — implement per workstream when chartered; production still **blocked**.

---

## 6. AI layer

- **Gates implemented** — default **deny** (`lib/ai-provider-gates.ts`).
- **AI-LAYER-GATEWAY-03** — unified gateway + rate limits (flags stay off).
- **Do not** enable live OpenAI without operator flags + governance.

---

## 7. History hygiene

- **Canonical:** history-v178 full file (merge v175 when on disk).
- Next append: **HISTORY-V179+** after major execute wave.

## Production (blocked)

No production ref, probes, Vercel Production changes, or production AI.
