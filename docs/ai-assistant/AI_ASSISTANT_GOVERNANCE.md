# AI Assistant — Governance and safety rules

**Prompt:** NEXT-AI-ASSISTANT-01  
**Companion:** [`AI_ASSISTANT_MASTER_SCOPE.md`](./AI_ASSISTANT_MASTER_SCOPE.md)

This document defines **non-negotiable** rules for any future AI Assistant / Copilot / planner code in this repo. It does not grant permission to bypass existing claim, product, or import governance.

---

## 1. Hard permission tiers

| Tier | Code / product behavior |
| --- | --- |
| **T0 — Read-only insight** | Assistant may only call tools and APIs that are explicitly read-only (SELECT, documented read-only routes, static artifact reads). Responses must include **source** and **environment** when inferring from data. |
| **T1 — Draft action** | Assistant may emit drafts (SQL text, prompt text, checklist markdown) that are **not executed** by the server on behalf of the user unless a separate human-triggered pipeline runs them. |
| **T2 — Operator-approved write** | Any mutation to production data (Supabase `INSERT`/`UPDATE`/`DELETE`, filing submit, import process) requires: (a) authenticated operator with appropriate role, (b) explicit **approval** control in UI or ticket, (c) where applicable, **Status: APPROVED** (or org-defined equivalent) on the governing artifact or change record. |
| **T3 — Admin-approved write** | Cross-tenant, destructive, or migration-class actions require admin approval and change window in addition to T2. |

**Default:** All assistant features ship at **T0** unless a feature flag promotes them (see below).

---

## 2. Non-negotiable safety rules

### 2.1 Production writes

- **No production writes** from assistant or planner code paths unless the governing human workflow shows **approved** state.
- Assistant must not use service-role keys in a way that bypasses RLS for “convenience”; follow existing `supabaseServer` / session patterns per route.

### 2.2 Preimage / post-verify / rollback

For any suggestion that touches:

- `resolved_product_id`, `resolved_catalog_product_id`, resolver status/confidence on Amazon tables,
- `products`, `product_identifier_map`, claim drafts, filing payloads, or enrichment generations,

the assistant **must**:

1. Reference the **preimage** artifact path or SQL snapshot concept.
2. Reference **post-verify** queries or expected row counts.
3. Reference **rollback** template (`DO NOT RUN`) where the repo pattern exists (e.g. NEXT-PRODUCT-23/27 packs).

If artifacts do not exist, the assistant answers **not_configured** / **blocked** and proposes the read-only prompt to create them — it does not invent execute SQL.

### 2.3 Feature flags

- Assistant / copilot UI and server routes that could call LLMs or suggest writes must be **disabled by default**.
- Suggested flag names (implementation in a later prompt):  
  - `AI_ASSISTANT_ENABLED`  
  - `AI_COPILOT_CLAIM_UI_ENABLED`  
  - `AI_COPILOT_PRODUCT_UI_ENABLED`  
  - `AI_ACTION_PLANNER_ENABLED`  
  - `AI_EXTERNAL_HTTP_ENABLED` (default **false**; includes OpenAI, Amazon, filing outbound)

### 2.4 External calls

- **Disabled unless approved:** OpenAI (`api.openai.com`), Amazon SP-API, arbitrary filing agent URLs, webhooks.
- Existing routes that already call OpenAI (e.g. chat proxy, packing slip, header AI) remain **operator-initiated**; the assistant must not chain them into autonomous loops without explicit flags and rate limits.

### 2.5 Migrations and schema

- Assistant must **not** apply migrations or run DDL. DDL prompts (e.g. NEXT-CONTINUOUS-CLAIM-ENRICHMENT-04) are human-governed and CI-reviewed.

### 2.6 Claims and PII

- Assistant outputs must minimize PII in logs; cite internal IDs and artifact paths instead of pasting large payloads.
- Filing and TRID flows remain **append-only** where product policy says so; assistant must not suggest overwrite of operator-selected TRID without a new governed prompt.

---

## 3. Alignment with repo patterns

- **Product propagation:** Follow `.cursor/audit-reports/next-product-*` preimage → signoff → execute → post-verify sequence.
- **Claims:** Follow claim review feature flags and readonly report scripts; align with `docs/claims/*` and `.cursor/audit-reports/next-claim-*`.
- **TRID:** Align with NEXT-CLAIM-TRID audit packs and filing payload contracts.
- **Enrichment:** Align with read-only diff API contracts in continuous enrichment audit artifacts.

---

## 4. Review cadence (recommended)

- Quarterly: re-run this governance doc against new API routes under `app/api/**` that call `fetch(` to third parties.
- After each new “execute” prompt family: add a subsection to MASTER_SCOPE linking the canonical `run_id` pattern.

---

AI_ASSISTANT_01_STATUS: COMPLETE
