# History pointers — authoritative

Full program narrative is **too large for chat**. Index to **latest canonical full history** and **paired-update law**.

---

## Latest canonical full history

**Repo-relative:**

```
.cursor/audit-reports/history-v175/20260604T120000Z/ERP_PIM_FULL_HISTORY_V175_APPEND_ONLY_CLAIM_RESOLVER_PREVIEW_STATUS.md
```

| Field | Value |
|-------|-------|
| Pack / run | `history-v175` / `20260604T120000Z` |
| Append slice | `v175-append.md` |
| Handoff | `handoff-summary.md` |
| Manifest | `manifest.json` |

**Prior (superseded):** `history-v174/20260603T120000Z/ERP_PIM_FULL_HISTORY_V174_APPEND_ONLY_PREVIEW_PRODUCT_MAPPING_STATUS.md`

**Note:** V176 orphan FK + wave-2 + preview close are in audits below; **HISTORY-V176+** append not yet written — do not paste full history into `.ai-memory`.

---

## Paired-update law (mandatory)

Every memory-changing audit updates **append-only full history + `.ai-memory` together** in one session. Never one without the other.

### Checklist

1. New `history-v###/<run_id>/` — copy prior full file + append `v###-append.md` (never shorten).
2. `.ai-memory` — `CURRENT_STATE.md`, `NEXT_ACTIONS.md`, topic files, this file if path changes.
3. `TASKS.md` — aligned with `NEXT_ACTIONS.md`.

**Docs-only memory sync** (this prompt): may refresh `.ai-memory` + `TASKS.md` from existing canonical history + audits; schedule **HISTORY-V176+** when facts outpace v175 append.

---

## Latest audit evidence (by topic)

| Topic | Latest run (under `.cursor/audit-reports/`) |
|-------|---------------------------------------------|
| **Memory sync** | `ai-shared-memory-update-v176/20260520T140000Z/` |
| Preview signoff | `env-06c-preview-operator-close-v175/20260519T223000Z/` |
| Claim V176 FK | `claim-candidate-resolver-v176-fk-orphan-product-fix/20260523T211500Z/` |
| Claim V175 | `claim-candidate-resolver-project-v175/20260524T120000Z/` |
| Mapping wave-2 | `product-id-mapping-wave-2-v176/20260520T132000Z/` |
| Mapping V174 | `product-id-mapping-materialization-v174/20260519T231000Z/` |
| Schema smoke | `schema-product-combined-smoke-v175/20260519T240000Z/` |
| AI memory bootstrap | `ai-shared-memory-bootstrap-v176/20260519T223000Z/` |

---

## Read order

| Need | File |
|------|------|
| Now | `.ai-memory/CURRENT_STATE.md` |
| Timeline | Canonical full history path above |
| Handoff | `history-v175/.../handoff-summary.md` |
| Hard stops | `.ai-memory/FORBIDDEN_ACTIONS.md` |

---

## Environment & approvals

- `.cursor/environment-policy/final-env-topology-v170.md`
- `.cursor/operator-approvals/production-readiness-01-approval.md`
- `.cursor/operator-approvals/product-auto-create-governance-v165-approval.md`
- `.cursor/operator-approvals/staging-storage-clone-01-approval.md`
