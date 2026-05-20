# History pointers — authoritative

Index to **latest canonical full history (V178)** and audit evidence. Do not paste full history into `.ai-memory`.

---

## Latest canonical full history — V178

**Repo-relative:**

```
.cursor/audit-reports/history-v178/20260605T120000Z/ERP_PIM_FULL_HISTORY_V178_APPEND_ONLY_NEDA_HANDOFF_AI_GATES_PRODUCT_UI.md
```

| Field | Value |
|-------|-------|
| Pack / run | `history-v178` / `20260605T120000Z` |
| Append slice | `v178-append.md` |
| Handoff | `handoff-summary.md` |
| Chain merge | Prepend `history-v175/20260604T120000Z/ERP_PIM_FULL_HISTORY_V175_*.md` when on disk |

**Prior slice:** `history-v175/20260604T120000Z/`

---

## V178 memory update (this run)

`ai-memory-update-after-v178-handoff/20260605T140000Z/` — refreshed `.ai-memory` + `TASKS.md` from V178 handoff facts (no code/DB).

---

## Key audit evidence

| Topic | Path |
|-------|------|
| Neda UI connector | `product-linkage-ui-data-connector-v178/20260520T150000Z/` |
| AI gates (plan) | `ai-layer-harden-01-v178/20260519T233600Z/` |
| AI gates (code) | `lib/ai-provider-gates.ts` |
| V176 close | `claim-candidate-resolver-v176-final-verify-close/20260524T140000Z/` |
| V177 blockers | `claim-upstream-blockers-v177/20260524T160000Z/` |
| Mapping wave-2 | `product-id-mapping-wave-2-v176/` |
| Hardening roadmap | `hardening-roadmap-v177/20260524T180000Z/` |
| Memory sync V177 | `ai-memory-history-sync-v177/20260524T170000Z/` |

---

## Paired-update law (mandatory)

Every memory-changing audit updates **append-only full history + `.ai-memory` together.**

1. New `history-v###/<run_id>/` — prior full file + `v###-append.md` (never shorten).
2. Refresh `.ai-memory` topic files + `TASKS.md`.
3. Bump **this file** if canonical path changes.

---

## Read order

| Need | Read |
|------|------|
| Now | `.ai-memory/CURRENT_STATE.md` |
| Neda | `.ai-memory/NEDA_HANDOFF.md` |
| Timeline | V178 full history path above |
| Hard stops | `.ai-memory/FORBIDDEN_ACTIONS.md` |

---

## Environment & approvals

- `.cursor/environment-policy/final-env-topology-v170.md`
- `.cursor/operator-approvals/production-readiness-01-approval.md`
- `.cursor/operator-approvals/product-auto-create-governance-v165-approval.md`
