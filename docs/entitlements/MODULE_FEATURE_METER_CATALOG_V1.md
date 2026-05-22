# Module, feature, and meter catalog — v1 (canonical)

<!-- markdownlint-disable MD013 MD060 -->

**Slice:** NEXT-PLATFORM-ENTITLEMENTS-02  
**Status:** Documentation + static TypeScript catalogs only. No database, no runtime enforcement, no billing provider integration.

**Code reference:** [lib/entitlements/catalog.ts](../../lib/entitlements/catalog.ts), [lib/entitlements/types.ts](../../lib/entitlements/types.ts)

---

## 1. Architecture overview

The platform separates four concerns that are often conflated:

| Layer | Question it answers | Examples |
|--------|---------------------|----------|
| **RBAC / fine permissions** | *Who* is allowed to perform an action? | Role `tenant_admin`, action key for `assertClaimPermission`, route-level role checks. |
| **Store access** | *Which store* may this user act on for store-scoped data? | `user_store_assignments`, `GET /api/claims/my-stores`, virtual admin coverage. |
| **Entitlement** | *What* has the tenant or store purchased or enabled? | Plan includes `claims.inbox.read`, trial on `ai_agents`, store override disables `ocr.slip_reader.page`. |
| **Usage / metering** | *How much* was consumed for limits, credits, and later billing? | `ai.token`, `ocr.page`, `api.call` with idempotency keys and aggregates. |
| **Feature flag** | *Should this code path be live* for rollout or safety? | Server-evaluated flags; technical enablement, not a substitute for entitlements. |

**Entitlement** answers commercial and product packaging (modules on/off). **RBAC** answers governance within an entitled surface. **Store access** answers multi-store isolation for a user. **Usage** answers consumption accounting.

---

## 2. Gate order (recommended server-side evaluation)

For mutating or costly operations, evaluate in this order:

1. **Organization gate** — Session valid; user may access the organization (e.g. `assertUserCanAccessOrganization`).
2. **Store scope** — If the operation is store-scoped, the user has access to that store (assignments / virtual admin / org policy).
3. **Entitlement** — Tenant or store has the feature enabled (plan + overrides); not expired; not hard-disabled by platform.
4. **Usage limit** — Remaining quota, credits, or rate window allows the operation (hard block vs soft overage is a product policy).
5. **RBAC / fine permission** — User role or domain permission allows the action (e.g. `assertClaimPermission` for claim actions).
6. **Execute** — Perform the operation.
7. **Record usage** — Append-only usage event with idempotency (after success, or after token count for AI; void on definitive failure per meter policy).

Reads may skip usage recording or use sampling, but entitlements should still be checked when the read exposes paid data or expensive paths.

---

## 3. Module catalog

**Naming:** `module_key` is `snake_case`, globally unique.  
**Scopes:** `tenant` (org-wide), `store` (per marketplace location / store row), `hybrid` (org license with per-store caps or overrides — use in future rows), `platform` (cross-tenant operator / reseller).

Authoritative counts and fields are mirrored in `MODULE_CATALOG` in code. Summary:

| module_key | Display name | Scope | Description (short) | Dependencies | Standalone behavior |
|------------|--------------|-------|---------------------|----------------|---------------------|
| `core_platform` | Core Platform | tenant | Orgs, users, roles, audit, baseline settings | — | Always-on foundation |
| `pim_product_graph` | PIM / Product graph | tenant | Product graph, identifiers, PIM | `core_platform` | Exports / snapshots if sync off |
| `imports_etl` | Imports / ETL | tenant | Ingest, staging, validation | `core_platform` | Error CSV / manual download |
| `marketplace_api_sync` | Marketplace API sync | store | REST/stream integrations | `core_platform` | Payload archive, manual replay |
| `returns` | Returns | store | RMA, disposition | `core_platform` | Local queue + CSV |
| `smart_scanner` | Smart scanner | store | Device/camera capture, decode | `core_platform` | Media + manual SKU if graph off |
| `ocr_slip_reader` | OCR / slip reader | store | Slip OCR, extraction | `core_platform`, `smart_scanner` | Raw OCR + human confirm |
| `warehouse` | Warehouse | store | Locations, pallets, moves | `core_platform` | Paper pick lists + CSV |
| `inventory_fefo` | Inventory / FEFO | store | Lots, expiry, FEFO | `core_platform`, `warehouse` | Static snapshot export |
| `claims_inbox` | Claims inbox | store | Candidate queues, triage | `core_platform` | CSV export of candidates |
| `claims_workflow` | Claims workflow | store | Tasks, SLAs, PDFs | `core_platform`, `claims_inbox` | Evidence ZIP + manual submit |
| `marketplace_claim_submit` | Marketplace claim submission | store | Submit to marketplace | `core_platform`, `claims_workflow` | Packaged payload + checklist |
| `reimbursements` | Reimbursements | tenant | Payout / reimbursement tracking | `core_platform`, `claims_workflow` | Spreadsheet-style export |
| `sales_intelligence` | Sales intelligence | store | Rank, share, opportunities | `core_platform`, `marketplace_api_sync` | Cached snapshot / stale banner |
| `inventory_forecasting` | Inventory forecasting | store | Demand / lead-time models | `core_platform`, `inventory_fefo`, `marketplace_api_sync` | Heuristic CSV without auto PO |
| `purchase_recommendations` | Purchase recommendations | store | PO suggestions | `core_platform`, `inventory_forecasting` | Rule-of-thumb list + disclaimers |
| `pricing_intelligence` | Pricing intelligence | store | Competitive pricing | `core_platform`, `marketplace_api_sync` | Static comparison export |
| `ai_assistant` | AI assistant | tenant | Copilot / assisted authoring | `core_platform` | Static help when models off |
| `ai_agents` | AI agents | tenant | Autonomous agents | `core_platform`, `ai_assistant` | Manual runbooks |
| `reporting_dashboards` | Reporting / dashboards | tenant | Dashboards, schedules | `core_platform` | Ad hoc CSV only |
| `accounting_cost_basis` | Accounting / cost basis | tenant | COGS, GL-ready outputs | `core_platform`, `inventory_fefo` | GL CSV without posting |
| `hr_operator_performance` | HR / operator performance | tenant | Labor metrics | `core_platform`, `warehouse` | Aggregate CSV |
| `white_label_platform_admin` | White-label / platform admin | platform | Reseller / tenant provisioning | `core_platform` | Standard admin until entitled |

**Count:** 23 modules (see `MODULE_CATALOG`).

---

## 4. Feature catalog

**Naming:** `feature_key` uses dot-separated segments: `domain.area.capability` (lowercase).

Each feature row in code includes: `moduleKey`, `scope`, `risk`, `requiresStore`, `meterKeys`, `dependencies`, `disabledBehavior`.

| feature_key | module_key | Scope | Risk | requires_store | Meter keys (examples) | Dependencies | Disabled behavior (summary) |
|-------------|------------|-------|------|----------------|----------------------|--------------|------------------------------|
| `claims.inbox.read` | `claims_inbox` | store | low | yes | `report.run` | — | Deny route; export-only / upgrade |
| `claims.workflow.task_create` | `claims_workflow` | store | medium | yes | `workflow.task` | `claims.inbox.read` | Inbox read-only; no task mutations |
| `claims.marketplace_submit` | `marketplace_claim_submit` | store | high | yes | `claim.submission`, `api.call` | `claims.workflow.task_create` | ZIP + instructions; no API submit |
| `claims.pdf_generation` | `claims_workflow` | store | low | yes | `claim.pdf` | `claims.inbox.read` | HTML summary only |
| `claims.repeat_followup` | `claims_workflow` | store | medium | yes | `workflow.repeat_task` | `claims.workflow.task_create` | No scheduled follow-ups |
| `claims.sla_escalation` | `claims_workflow` | store | medium | yes | `workflow.task` | `claims.workflow.task_create` | No auto-escalation |
| `claims.ai.draft` | `ai_assistant` | store | medium | yes | `ai.token`, `ai.credit` | `claims.inbox.read` | Static templates only |
| `claims.ai.autonomous_agent` | `ai_agents` | store | high | yes | `ai.agent_run`, `ai.credit` | `claims.ai.draft` | Manual triage; no agent runs |
| `returns.scanner.capture` | `smart_scanner` | store | low | yes | `scanner.event`, `storage.gb_month` | — | Manual SKU path only |
| `returns.ai.triage` | `returns` | store | medium | yes | `ai.token`, `ai.credit` | `returns.scanner.capture` | Human triage only |
| `warehouse.pallets` | `warehouse` | store | low | yes | `workflow.task` | — | Location-only / pallets hidden |
| `warehouse.locations` | `warehouse` | store | low | yes | — | — | Map read-only |
| `warehouse.disposal` | `warehouse` | store | medium | yes | `workflow.task` | `warehouse.locations` | CSV log for manual processing |
| `inventory.fefo.allocate` | `inventory_fefo` | store | medium | yes | `workflow.task` | `warehouse.locations` | Manual FIFO export |
| `inventory.forecasting.run` | `inventory_forecasting` | store | low | yes | `forecast.run`, `report.run` | `inventory.fefo.allocate` | Last snapshot read-only |
| `api.amazon.sync.orders` | `marketplace_api_sync` | store | medium | yes | `api.call`, `import.row` | — | Manual CSV import |
| `api.walmart.sync.inventory` | `marketplace_api_sync` | store | medium | yes | `api.call`, `import.row` | — | Stale inventory banner |
| `ocr.slip_reader.page` | `ocr_slip_reader` | store | low | yes | `ocr.page`, `ai.credit` | `returns.scanner.capture` | Upload retained; OCR not run |
| `reports.advanced.scheduled` | `reporting_dashboards` | tenant | low | no | `report.run`, `storage.gb_month` | — | Small ad hoc CSV only |
| `sales.rank_tracking` | `sales_intelligence` | store | low | yes | `sales.lookup`, `api.call` | `api.amazon.sync.orders` | Cached table; no live refresh |
| `sales.opportunity_finder` | `sales_intelligence` | store | medium | yes | `sales.lookup`, `ai.credit` | `sales.rank_tracking` | Ranks only; heuristics hidden |

**Count:** 21 features (see `FEATURE_CATALOG`).

---

## 5. Meter catalog

| meter_key | Unit (normalized) | Billable | Aggregation window | Idempotency scope (summary) |
|-----------|-------------------|----------|----------------------|-----------------------------|
| `seat.user` | boolean_slot | yes | month | per org / user / period |
| `store.active` | boolean_slot | yes | month | per org / store / period |
| `ai.token` | token | yes | day | per org / idempotency key |
| `ai.credit` | credit | yes | billing_period | per org / idempotency key |
| `ai.agent_run` | count | yes | day | per org / agent run id |
| `ocr.page` | page | yes | day | per store / document id |
| `api.call` | call | yes | day | per store / provider request id |
| `import.file` | file | yes | day | per org / file checksum |
| `import.row` | row | yes | day | per org / batch row id |
| `claim.submission` | count | yes | month | per store / submission id |
| `claim.pdf` | count | yes | day | per org / artifact id |
| `workflow.task` | count | yes | day | per org / task transition id |
| `workflow.repeat_task` | count | yes | month | per org / recurrence instance id |
| `report.run` | count | yes | day | per org / report run id |
| `scanner.event` | count | yes | day | per store / scan session id |
| `storage.gb_month` | gb_month | yes | month | per org / monthly snapshot |
| `sales.lookup` | count | yes | day | per store / lookup id |
| `forecast.run` | count | yes | day | per store / forecast job id |

**Count:** 18 meters (see `METER_CATALOG`).

---

## 6. Functional module I/O contracts (examples)

If a downstream entitlement is missing, the upstream module **must not hard-fail**; it returns a **standalone** artifact and marks downstream as skipped or manual-review.

### 6.1 Smart Returns Scanner

| Field | Value |
|-------|--------|
| **Inputs** | `store_id`, `image_blob_ref`, optional `device_id`, `session_id`, `captured_at_utc` |
| **Outputs** | `decoded_candidates[]`, `raw_media_ref`, `confidence`, `downstream_status` |
| **Required entitlements** | `returns.scanner.capture` |
| **Optional downstream** | `pim_product_graph` (SKU resolution), `ocr_slip_reader.page` |
| **Blocked downstream** | Unresolved SKU list; operator mapping queue |
| **Standalone** | Decode text + media stored; CSV export of session |
| **Usage meters** | `scanner.event`, `storage.gb_month` |
| **Permission keys** | Store-scoped write on returns ingest (RBAC TBD per route) |
| **Timezone policy** | Display “received” in resolved store TZ; store `captured_at_utc` |
| **Audit types** | `returns.scan.started`, `returns.scan.completed`, `returns.scan.downstream_skipped` |

### 6.2 Claim Engine

| Field | Value |
|-------|--------|
| **Inputs** | `organization_id`, `store_id`, `candidate_id`, optional `evidence_refs[]` |
| **Outputs** | `candidate_view`, `workflow_state`, `evidence_pack_ref`, `downstream_status` |
| **Required entitlements** | `claims.inbox.read`; mutations need `claims.workflow.*` features |
| **Optional downstream** | `claims.marketplace_submit`, `claims.pdf_generation`, `claims.ai.draft` |
| **Blocked downstream** | Evidence ZIP + manual marketplace checklist |
| **Standalone** | Read-only inbox + export |
| **Usage meters** | `workflow.task`, `claim.pdf`, `claim.submission`, `ai.token` |
| **Permission keys** | `assertClaimPermission` action keys (domain-specific) |
| **Timezone policy** | SLA due dates computed in store TZ, stored UTC |
| **Audit types** | `claims.candidate.viewed`, `claims.task.created`, `claims.submit.skipped` |

### 6.3 Inventory / FEFO

| Field | Value |
|-------|--------|
| **Inputs** | `store_id`, `sku`, `lot_id`, `quantity`, `allocation_context` |
| **Outputs** | `allocation_result`, `reservations[]`, `downstream_status` |
| **Required entitlements** | `inventory.fefo.allocate` |
| **Optional downstream** | `accounting_cost_basis` (posting), `purchase_recommendations` |
| **Blocked downstream** | Allocation result without GL posting; export for accounting |
| **Standalone** | Manual FIFO list CSV |
| **Usage meters** | `workflow.task` |
| **Permission keys** | Warehouse write roles (RBAC TBD) |
| **Timezone policy** | Expiry display in store TZ |
| **Audit types** | `inventory.allocate.completed`, `inventory.posting.skipped` |

### 6.4 AI / OCR Slip Reader

| Field | Value |
|-------|--------|
| **Inputs** | `store_id`, `image_ref`, `document_id` |
| **Outputs** | `ocr_fields`, `confidence_map`, `downstream_status` |
| **Required entitlements** | `ocr.slip_reader.page` |
| **Optional downstream** | `claims.ai.draft`, `returns.ai.triage` |
| **Blocked downstream** | Raw OCR JSON + human confirmation queue |
| **Standalone** | Text extraction only |
| **Usage meters** | `ocr.page`, `ai.credit`, `ai.token` |
| **Permission keys** | Store write on OCR job create |
| **Timezone policy** | Document “slip date” parsed as local date + source TZ if provided |
| **Audit types** | `ocr.job.started`, `ocr.job.completed`, `ocr.downstream_skipped` |

### 6.5 Marketplace API Sync

| Field | Value |
|-------|--------|
| **Inputs** | `store_id`, `resource`, `sync_cursor`, `provider` |
| **Outputs** | `normalized_batch_ref`, `sync_log_id`, `downstream_status` |
| **Required entitlements** | e.g. `api.amazon.sync.orders` |
| **Optional downstream** | `pim_product_graph`, `inventory_fefo` |
| **Blocked downstream** | Blob JSON + suggested import job; no auto-upsert |
| **Standalone** | Archived payloads + operator replay |
| **Usage meters** | `api.call`, `import.row` |
| **Permission keys** | Connector admin / operator roles |
| **Timezone policy** | Marketplace report timestamps shown in store TZ with UTC tooltip |
| **Audit types** | `api.sync.started`, `api.sync.completed`, `api.sync.downstream_skipped` |

### 6.6 Sales Intelligence

| Field | Value |
|-------|--------|
| **Inputs** | `store_id`, `asin_set`, `run_type` |
| **Outputs** | `rank_table_ref`, `opportunities[]?`, `stale_at`, `downstream_status` |
| **Required entitlements** | `sales.rank_tracking`; opportunities need `sales.opportunity_finder` |
| **Optional downstream** | `pricing_intelligence`, `ai_assistant` (narration) |
| **Blocked downstream** | Cached snapshot + `stale_at`; no live refresh |
| **Standalone** | CSV of last successful run |
| **Usage meters** | `sales.lookup`, `api.call`, `ai.credit` |
| **Permission keys** | Read roles for BI surfaces |
| **Timezone policy** | “As of” wall time in store TZ |
| **Audit types** | `sales.lookup.run`, `sales.lookup.skipped` |

---

## 7. Timezone policy

- **Persistence:** Store instants as **UTC** (`timestamptz`) for `created_at`, `due_at`, sync times, audit rows.
- **Display precedence:** `user` timezone → `store` → `organization` → `platform default` → **UTC** fallback.
- **Source events:** Preserve `source_event_time` and `source_timezone` (or offset) from marketplaces; normalize to UTC for computation; keep originals in JSON for audit.
- **SLA / repeating tasks:** Compute `due_at_utc` using business rules anchored in **store** (or org) timezone; persist UTC.
- **Reports / PDFs:** Render “generated at” using the resolved display TZ; footnote UTC where legally useful.
- **Billing periods:** Define `billing_timezone` on the subscription or org; aggregate usage buckets in that TZ for invoice alignment.

---

## 8. Entitlement precedence (summary)

When a resolver is implemented (future slice), recommended order:

1. Platform hard deny / compliance  
2. Feature flag (server-side)  
3. Subscription plan baseline  
4. Tenant subscription state (e.g. past_due policy)  
5. Tenant entitlement overrides  
6. Store entitlement overrides  
7. RBAC / fine permission  
8. Store user assignment (user cannot act on store)  
9. Usage limit (quota / credits)

Narrower scope overrides broader for **that** store; explicit **deny** should win over grant where configured.

---

## 9. Do-not-touch (this slice)

- No database migrations or tables.
- No runtime enforcement in API routes or jobs.
- No billing provider (e.g. Stripe).
- No AI or marketplace calls.
- No changes to Claim Inbox behavior.
- No UI gating implementation.

---

## 11. Resolver skeleton (NEXT-PLATFORM-ENTITLEMENTS-03)

Pure TypeScript API (no DB, no route wiring): [lib/entitlements/resolve-entitlement.ts](../../lib/entitlements/resolve-entitlement.ts).

| Export | Role |
|--------|------|
| `resolveEntitlement` / `assertEntitlement` | Return `EntitlementDecision` (`ok`, `status`, `reasonCodes`, `sourceTrace`, …). Default **allow** for cataloged features until subscription data exists. |
| `requireEntitlement` | Same resolution; throws `EntitlementError` when denied. |
| `getFeatureMeters` / `getFeatureDependencies` | Read-through to `FEATURE_CATALOG`. |
| `resolveUsageLimit` | Placeholder: always allows with `USAGE_NOT_ENFORCED_STATIC`. |
| `recordUsageEventNoop` | No-op result; **no** persistence. |

Smoke: `npx tsx scripts/entitlement-resolver-smoke.ts`.

---

## 12. Next steps (recommended)

1. **Entitlement DB plan** — `tenant_entitlements`, `store_entitlement_overrides`, subscription tables; wire `resolveEntitlement` to read resolver output.
2. **Timezone resolver audit** — document `organizations` / `stores` / `profiles` fields and `resolveDisplayTimezone()` before migrations.
3. **Product identity / `product_id` roadmap** — resume when catalog and gates are stable.
4. **API ingestion plan** — align marketplace sync meters with `recordUsageEvent` (real implementation later).

Choose the next Agent slice based on whether commercial gating or data correctness is the current priority.
