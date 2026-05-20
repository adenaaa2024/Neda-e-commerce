# History pointers — authoritative

Do not paste full history into `.ai-memory`.

**Restore order:** V182 canonical rebuild → **V183 append** → (optional) V184+ / V189 on disk.

---

## Latest canonical full history — V182 (rebuilt base)

```
.cursor/audit-reports/history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md
```

| Field | Value |
|-------|-------|
| Pack / run | `history-canonical-rebuild-v182` / `20260518T120000Z` |
| Method | git `feab1b0` V175 + verbatim V176–V181 embeds |
| Rules | NO deletion · NO summarization · NO minification |
| Companions | `NEXT_CHAT_BOOTSTRAP.md`, `HISTORY_INDEX.md`, `HISTORY_TIMELINE.md` |

Embedded at start of V183 (and later operator files).

---

## Latest operator slice — V183 (Neda env + FBM dry-run)

```
.cursor/audit-reports/history-v183/20260520T230000Z/ERP_PIM_FULL_HISTORY_V183_APPEND_ONLY_NEDA_ENV_FBM_DRY_RUN_STATUS.md
```

| Field | Value |
|-------|-------|
| Pack / run | `history-v183` / `20260520T230000Z` |
| Append slice | `v183-append.md` |
| Body | Full V182 + V183 append |

**Memory sync (this prompt):** `ai-memory-update-after-v183/20260524T180000Z/`

---

## Later on disk (not V183 baseline)

| Pack | Path |
|------|------|
| V184 | `history-v184/20260520T240000Z/` |
| V185 | `history-v185/20260520T240000Z/` (if present) |
| V189 closure | `history-v189/20260524T140000Z/` |

Use V183 file for V181–V183 facts; use V189 for post-closure staging counts.

---

## Key audit evidence (V183 era)

| Topic | Path |
|-------|------|
| V183 memory | `ai-memory-update-after-v183/20260524T180000Z/` |
| V181 signoff | `expected-inventory-neda-read-model-signoff-v181/20260521T120000Z/` |
| FBM V183 dry-run | `return-items-fbm-aware-dry-run-v183/20260521T140000Z/` |
| Map enrichment V185 | `return-items-identifier-map-enrichment-v185/20260521T160000Z/` |
| V179 inventory | `inventory-views-product-linkage-contract-v179/` |

---

## Paired-update law

History append + `.ai-memory` updated **together** in one session.

---

## Read order

| Need | Read |
|------|------|
| Now | `.ai-memory/CURRENT_STATE.md` |
| Cold start | `history-canonical-rebuild-v182/.../NEXT_CHAT_BOOTSTRAP.md` |
| V183 facts | V183 operator path above |
| Neda | `.ai-memory/NEDA_HANDOFF.md` |
| Hard stops | `.ai-memory/FORBIDDEN_ACTIONS.md` |

---

## Environment & approvals

- `.cursor/environment-policy/final-env-topology-v170.md`
- `.cursor/operator-approvals/production-readiness-01-approval.md`
