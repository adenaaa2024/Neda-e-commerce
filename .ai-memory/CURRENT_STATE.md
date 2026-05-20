# Current state — V178 (authoritative)

**Last updated:** 2026-06-05 (`ai-memory-update-after-v178-handoff` `20260605T140000Z`)  
**Canonical full history:** [HISTORY_POINTERS.md](HISTORY_POINTERS.md) →  
`.cursor/audit-reports/history-v178/20260605T120000Z/ERP_PIM_FULL_HISTORY_V178_APPEND_ONLY_NEDA_HANDOFF_AI_GATES_PRODUCT_UI.md`  
**Paired-update law:** change with history append, not alone.

## Gates (summary)

| Gate | Status |
|------|--------|
| Build / schema smoke V175 | **PASS** (21/21) |
| Storage **144/144** | **PASS** |
| Schema reconcile | **PASS** |
| Preview operator signoff | **PASS** (ENV-06C close V175) |
| **NEDA V178 backend + UI handoff** | **PASS** — contract consumable; connector wired |
| **ProductLinkageDisplayContract** | **CANONICAL** |
| **Product mapping** | **Partial but operational** (spine 100%; wave-2 applied; gaps remain) |
| **AI provider gates** | **IMPLEMENTED** — **default deny**; no live AI |
| Hardening roadmap V177 / AI plan V177 | **PASS** (artifacts) |
| Claim V176 draft orphan FK | **PASS_CLOSED** |
| Claim V177 blockers plan | **PASS** (read-only) |
| Production | **NOT_CREATED_YET** / **BLOCKED** |
| Vercel Production | **UNTOUCHED** (`kxsvedvpjldygtdbylsy`) |
| `package_items` | **FORBIDDEN** / absent |

## Database refs

| Role | Ref |
|------|-----|
| Original | `kxsvedvpjldygtdbylsy` |
| Staging / local / Preview | `eiqfaapyumhixxoeltgu` |
| Production | `NOT_CREATED_YET` |

## Claim coverage (staging — live)

| Table | Resolved | Total | % | Unresolved |
|-------|----------|-------|---|------------|
| `claim_candidates` | 6,581 | 9,055 | **72.7%** | 2,474 |
| `claim_candidate_drafts` | 4,710 | 9,137 | **51.5%** | 4,427 |

Drafts: **0** FK violations vs `products.id` (V176). ~4,736 **candidate** orphan FK rows (V175 legacy) — separate charter.

**UI policy:** Unresolved / ambiguous / mismatch rows use safe labels via V178 connector — never infer product from title/OCR in UI.

## Neda integration (V178)

- **Backend contract is consumable now** — `ProductLinkageDisplayContract` + enrich path.
- **Approved server actions only** — `app/returns/product-linkage-display-actions.ts` (`fetchProductLinkageDisplayContract`, `buildProductLinkageDisplayContracts`).
- **No direct browser Supabase writes** for linkage/catalog mutations — use server actions / existing app patterns.
- Surfaces wired: claim inbox, draft panel, manifest lines, return item labels (`product-linkage-ui-data-connector-v178`).

## Mapping / catalog

- Spine `products` + `product_identifier_map`: **100%**
- Operational tables: **partial** — wave-2 applied; `slip_contents` 0%; settlements governed-only
- `return_items`: **6 test rows** — not KPIs

## AI gates (default deny)

`lib/ai-provider-gates.ts` — requires `AI_EXTERNAL_HTTP_ENABLED` + per-surface flags. **Live AI off** unless operator explicitly enables.

## Evidence

| Topic | Folder |
|-------|--------|
| V178 history | `history-v178/20260605T120000Z/` |
| Neda connector | `product-linkage-ui-data-connector-v178/20260520T150000Z/` |
| V176 close | `claim-candidate-resolver-v176-final-verify-close/20260524T140000Z/` |
| V177 blockers | `claim-upstream-blockers-v177/20260524T160000Z/` |
