# AI Assistant — Master scope and capability map

**Prompt:** NEXT-AI-ASSISTANT-01  
**Mode:** Read-only inventory and design (no production changes in this deliverable).

This document maps what exists today versus what a governed **ERP/PIM copilot** should cover. It is not an implementation spec for a single feature; it aligns assistant work with existing domains and audit packs.

---

## 1. Existing surfaces (inventory summary)

| Category | What exists | Notes |
| --- | --- | --- |
| **OpenAI proxy / org keys** | Workspace-key–gated chat completions proxy; org OpenAI key resolution from DB/env | External HTTP to OpenAI when keys present |
| **OpenAI helpers** | Header classification, packing-slip vision, PIM price/category candidate pickers | Task-specific; not a unified assistant |
| **Settings / keys** | Settings UI for provider keys; `organization_api_keys`, `organization-openai-key` | Operator-controlled credentials |
| **Claim review** | Claim review ops page + client behind feature flags (`claim-review-workflow`) | Strong candidate for copilot context |
| **Product / PIM** | Catalog enrich routes using AI helpers; product dashboards showing OpenAI readiness | Suggestions must stay subordinate to governed writes |
| **Propagation / identity** | Scripts + audit packs (`product-propagation-dry-run`, `.cursor/audit-reports/next-product-*`) | **Read-only dry-runs and preimage packs** are the model for any assistant “execute” narrative |
| **TRID / claims** | Scripts (`claim-trid-*`), audit contracts under `.cursor/audit-reports/next-claim-trid-*` | Deterministic data; assistant explains candidates, never overwrites |
| **Filing** | Filing request handlers, internal pickup contracts (audit docs) | Outbound filing agent HTTP explicitly stubbed/disabled in contracts |
| **Continuous enrichment** | Diff API contract docs (`next-continuous-claim-enrichment-*`) | Read-only diff path emphasized in artifacts |
| **Amazon / resolver** | Universal importer, resolver verify SQL under `docs/product-identity/sql/` | Assistant cites migrations/views, does not run writes |
| **Removal / Phase-4** | Referenced in plans and claim MVP readonly report buckets | Copilot = read-only insight + link to next governed prompt |

There is **no** single product named “AI Assistant” in the repo today; capabilities are **scattered** across API routes, `lib/*-openai*.ts`, settings, and claim/product UIs.

---

## 2. Assistant capability map (by domain)

Each cell: **Today** (what repo supports) → **Target assistant role** (governed).

### Product Identity

- **Today:** Dry-run orchestrator (`scripts/product-propagation-dry-run.ts`, `lib/audits/product-propagation-dryrun.ts`); preimage/signoff packs; optional `v_product_identity` read model.
- **Assistant:** Summarize would_write / would_review / dispute cohorts; link to latest audit `run_id`; propose **exact next prompt** (e.g. NEXT-PRODUCT-31); never apply `UPDATE` without operator pack + approval.

### Claim Review

- **Today:** `app/claim-engine/review-ops/*`, feature flags in `lib/claim-review-workflow`.
- **Assistant:** Draft review notes, checklist gaps, link to claim draft SQL/docs; surface blockers from readonly reports (`scripts/claim-mvp-readonly-report.ts` patterns).

### TRID selection

- **Today:** `scripts/claim-trid-02-draft-extraction-dryrun.ts`, audit packs; filing payload contract extensions documented.
- **Assistant:** Explain deterministic vs ambiguous vs missing outcomes; cite `financial_reference_resolver` / draft joins; output **append-only** selection guidance matching NEXT-CLAIM-TRID-06 direction.

### Continuous Enrichment

- **Today:** Contract docs under `.cursor/audit-reports/next-continuous-claim-enrichment-*` (read-only diff API emphasis).
- **Assistant:** Summarize configured vs not_configured paths; never replay writes without additive DDL prompt approval.

### Filing Agent

- **Today:** `lib/claim-filing-request-handlers.ts`, internal pickup routes; audit: worker pickup stubbed, external URL disabled until approved adapter.
- **Assistant:** Explain lease/pickup state; payload shape; **no** autonomous outbound filing.

### Amazon Report Reference Graph

- **Today:** Importer, report type registry, header AI (`app/api/settings/imports/reports-repo-header-ai/route.ts`).
- **Assistant:** Map report type → target table; cite migrations; flag unsupported types; no silent import execution.

### Universal Resolver

- **Today:** Product identity SQL under `docs/product-identity/sql/`; propagation dry-run.
- **Assistant:** Explain resolver columns, preimage/rollback packs; align language with governed execute prompts.

### Removal Phase-4

- **Today:** Plan/audit references (`next-claim-22-hold`, removal buckets in claim reports).
- **Assistant:** Read-only spine/evidence gap explanation; link to removal-specific prompts; no evidence mutation.

---

## 3. Permission tiers (concrete)

| Tier | Name | Assistant may | Human / system gate |
| --- | --- | --- | --- |
| **T0** | Read-only insight | Query allowed read APIs / RLS-safe views; summarize audit artifacts | Default |
| **T1** | Draft action | Produce markdown/SQL **drafts** in chat or copy-paste buffers; open PR text | Operator review |
| **T2** | Operator-approved write | Suggest exact governed prompt + preimage path | **Status: APPROVED** (or equivalent org policy) + preimage/signoff checklist |
| **T3** | Admin-approved write | Same as T2 for destructive or cross-tenant scope | Admin role + change window |

Assistant runtime must **default to T0**; T1–T3 require explicit UI or prompt flags (see `AI_ASSISTANT_GOVERNANCE.md`).

---

## 4. Non-negotiable safety rules (summary)

Full detail: [`AI_ASSISTANT_GOVERNANCE.md`](./AI_ASSISTANT_GOVERNANCE.md).

- No production writes without documented approval (`Status: APPROVED` or org-equivalent).
- Write suggestions must reference **preimage**, **post-verify**, and **rollback** artifacts when touching resolver/product/claim rows.
- Feature flags for assistant/copilot **default off**.
- External calls (OpenAI, Amazon, filing URL) **disabled** unless explicitly enabled per environment and entitlements.

---

## 5. Files inspected (representative list)

See [`AI_ASSISTANT_01_FILES_INSPECTED.md`](./AI_ASSISTANT_01_FILES_INSPECTED.md) for the explicit path list produced during NEXT-AI-ASSISTANT-01.

---

## 6. Next implementation prompts (ordered)

Use **NEXT-AI-ASSISTANT-02** through **NEXT-AI-ASSISTANT-05** from ERP/PIM Next Prompts V140, then continue product/claim tracks as needed:

1. **NEXT-AI-ASSISTANT-02** — Read-only context + tool registry contract (+ tests proving no-write registry).
2. **NEXT-AI-ASSISTANT-03** — ERP action planner dry-run envelope (no writes; audit model stub).
3. **NEXT-AI-ASSISTANT-04** — Copilot UI shell (disabled by default; suggestion cards only).
4. **NEXT-AI-ASSISTANT-05** — Evals + safety regression pack.
5. **NEXT-PRODUCT-31** — AFI wave-2 preimage + signoff read-only (50 rows).
6. **NEXT-CLAIM-TRID-06** — TRID candidate read API + review drawer UI.
7. **NEXT-CONTINUOUS-CLAIM-ENRICHMENT-04** — Governed additive DDL + configured diff API.

---

AI_ASSISTANT_01_STATUS: COMPLETE
