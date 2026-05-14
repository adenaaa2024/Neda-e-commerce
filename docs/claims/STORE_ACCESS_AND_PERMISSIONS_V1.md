<!-- markdownlint-disable MD013 MD036 MD060 -->

# Store access and permissions — canonical spec v1

**Status:** Canonical review / signoff document (NEXT-CLAIM-28).  
**Scope:** Store access architecture, permission catalog v1, resolution order, wildcard policy, dangerous actions, AI boundaries, migration readiness.  
**Out of scope for this document:** SQL migrations, runtime code, workflow tables, marketplace or AI calls.

This document is the **source of truth** until superseded by `…_V2.md` after deliberate review.

---

## 1. Architecture overview

### Tenant and channel scope

- **`organization_id`** is **always required** for any claim-related authorization decision. It identifies the tenant boundary for data, settings, and audit.
- **`store_id`** identifies the **marketplace channel** (Amazon, Walmart, etc.) within the tenant. Operational and financial claims are anchored to a store.

### Org access is not store access

- **Organization membership** (e.g. user’s home `profiles.organization_id` and `assertUserCanAccessOrganization`) proves the user may act **somewhere** in that tenant.
- It does **not** prove the user may view or mutate claims for **every** store in that tenant.
- Therefore a **separate store access model** is required: **`user_store_assignments`** (see section 2).

### When `store_id` is mandatory

- **All `claims.marketplace.*` actions** require a concrete **`store_id`** in context (no org-only marketplace operations).
- **Recommended** for opening a case, uploading channel-specific evidence, and most workflow writes that attach to marketplace context: require **`store_id`** unless a future read-only aggregate explicitly documents otherwise.

### Why `user_store_assignments` is required

- Today, org-wide helpers (e.g. listing stores for an organization) do **not** filter by user; service-role code must not rely on RLS alone for authorization.
- Without explicit **user → store** rows (or an equivalent proven model), any org member could pass a valid `store_id` and reach workflows or submissions for stores they should not operate.
- Assignments provide **auditable**, **queryable** least privilege and enable **view / act / submit** gradation per store.

---

## 2. `user_store_assignments` ERD

### Table: `public.user_store_assignments`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `uuid` | NO | Primary key (e.g. `gen_random_uuid()`). |
| `organization_id` | `uuid` | NO | Tenant; must match parent `stores.organization_id`. |
| `profile_id` | `uuid` | NO | Subject; FK to `profiles.id`. |
| `store_id` | `uuid` | NO | FK to `stores.id`. |
| `access_level` | `text` | NO | One of: `view`, `act`, `submit` (see section 5). |
| `starts_at` | `timestamptz` | NO | When the assignment becomes effective (default `now()`). |
| `ends_at` | `timestamptz` | YES | `NULL` = no end; otherwise temporary access. |
| `source` | `text` | NO | Provenance: e.g. `manual`, `import`, `team_sync`, `system`. |
| `metadata` | `jsonb` | NO | Default `{}`; optional reason, ticket id, team slug, etc. |
| `created_at` | `timestamptz` | NO | Audit. |
| `updated_at` | `timestamptz` | NO | Last change; maintained by `set_updated_at` trigger. |
| `revoked_at` | `timestamptz` | YES | Soft revoke; `NULL` = active. |

### Semantics

- One logical assignment is **active** when `revoked_at IS NULL` and `starts_at <= now()` and (`ends_at IS NULL` OR `ends_at > now()`).
- **No “all stores” sentinel row** with `store_id = NULL` — use wildcard policy (section 4) to avoid ambiguous FKs and join bugs.

### Indexes (recommended)

- Partial **unique** active assignment: `(profile_id, store_id)` WHERE `revoked_at IS NULL` — **locked** in migration `20260812120000_user_store_assignments.sql` (no separate `is_active` column in v1).
- `(organization_id, profile_id, revoked_at)` and `(organization_id, store_id, revoked_at)` — list assignments for user / per store.
- Partial index on `ends_at` for active rows with a finite end — optional expiry sweeps.

### Foreign keys (policy)

- **`organization_id`**: **`ON DELETE RESTRICT`** on `public.organizations(id)` — cannot delete a tenant while assignments reference it (NEXT-CLAIM-30).
- **`store_id`**: **`ON DELETE RESTRICT`** — historical assignment rows keep a concrete `store_id`; prefer **soft-delete stores** (`is_active`) instead of hard delete while FK rows exist.
- **`profile_id`**: **`ON DELETE CASCADE`** when a profile (auth user) is removed.
- **RLS** is enabled in the same migration; **service role bypasses RLS** — server code must still enforce permission catalog and resolver rules.

### Wildcard policy (no extra rows)

- **Tenant admin all stores** and **platform** behavior are **not** represented by inserting every store row by default (see section 4). Optional **bootstrap job** may materialize rows for operational simplicity — product choice.

### Expiry and revoke

- **Expiry:** `ends_at` in the past → resolver treats as **no access** (same as missing row).
- **Revoke:** set `revoked_at` (and optionally `metadata.revoke_reason`); retain row for audit. Avoid hard delete except GDPR-driven processes.

---

## 3. Permission catalog v1

**Conventions**

- **Keys:** lowercase dot-separated: `<namespace>.<domain>.<action>`.
- **Namespaces:** `claims.*` (tenant), `platform.claims.*` (platform).
- **Risk:** `low` | `medium` | `high` | `critical` (for review prioritization; not stored in DB in v1).
- **Context:** `org` = `organization_id`; `store` = `store_id`; `family` = optional claim family slug.

**`store_id` mandatory column:** `yes` = enforcement must fail without store; `reco` = strongly recommended; `no` = org-level read OK if product allows.

### Read — `claims.inbox.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.inbox.view` | low | org + optional store for scoped inbox | reco |
| `claims.inbox.search` | low | org + optional store | reco |

### Case — `claims.case.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.case.view` | low | org + store (or wildcard) | reco |
| `claims.case.open` | medium | org + store | reco |
| `claims.case.assign` | medium | org + store | reco |
| `claims.case.reopen` | high | org + store | reco |
| `claims.case.close` | high | org + store | reco |

### Task — `claims.task.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.task.view` | low | org + store | reco |
| `claims.task.claim` | medium | org + store | reco |
| `claims.task.complete` | medium | org + store | reco |
| `claims.task.reassign` | medium | org + store | reco |

### Event / audit read — `claims.event.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.event.view` | low | org; store optional for filtered views | no |

### Evidence — `claims.evidence.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.evidence.upload` | medium | org + store | reco |
| `claims.evidence.delete` | critical | org + store | yes |

### Product / PIM — `claims.product.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.product.link` | medium | org + store | reco |
| `claims.pim.override_block` | critical | org + store | reco |

### Marketplace — `claims.marketplace.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.marketplace.open_case` | high | org + store | **yes** |
| `claims.marketplace.submit` | critical | org + store | **yes** |
| `claims.marketplace.follow_up` | high | org + store | **yes** |

### AI — `claims.ai.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.ai.view_suggestions` | low | org + store (reco) | reco |
| `claims.ai.apply_suggestion` | high | org + store; must not imply marketplace submit | reco |

### Workflow admin — `claims.workflow.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.workflow.admin` | critical | org; store optional depending on policy UI | no |

### Settings — `claims.settings.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `claims.settings.manage` | critical | org; store override keys may be scoped in payload | no |

### Platform — `platform.claims.*`

| Key | Risk | Context | `store_id` mandatory |
|-----|------|---------|------------------------|
| `platform.claims.impersonate_read` | critical | platform actor + target org | no (cross-tenant read rules) |
| `platform.claims.audit` | high | platform actor | no |

---

## 4. Permission resolution order

Evaluators run **in order**; the first **definitive deny** stops with denial. The first **definitive allow** after all checks passes.

1. **Authentication** — User/session present; otherwise deny (401).
2. **Organization access** — User may access `organization_id` (e.g. `assertUserCanAccessOrganization` pattern: home org match or platform staff per policy). Deny (403) if fail.
3. **Explicit deny list** (future ABAC) — Optional `DENY` grants; if matched, deny immediately.
4. **Platform override** — If actor is platform staff and action is `platform.claims.*` (or documented impersonation read), apply **narrow allow** with mandatory audit metadata; else continue.
5. **Role default bundle** — Permissions granted by default to `roles.key` (e.g. tenant_admin, employee) **without** per-user rows.
6. **Explicit grants** (future `user_permission_grants` or catalog tables) — Additive permissions.
7. **Store assignment** — Resolve effective store access:
   - If action requires `store_id`: verify `store_id` belongs to org (`assertStoreBelongsToOrganization`).
   - If user has **wildcard** `claims.scope.all_stores` (or tenant policy “admin all stores”): treat as pass **only** if policy enabled; expand to concrete `store_id` in audit logs for mutations.
   - Else: require active `user_store_assignments` row with sufficient **access_level** (section 5).
8. **Claim family restriction** — If permission or policy is scoped to allowed families, deny if `claim_family` not allowed.
9. **Action key** — Final check that the resolved permission set includes the requested key (or a strictly higher bundle that includes it).

### Deny precedence

- **Deny wins over allow** when both could apply (future-safe).
- **Missing store context** for keys marked **mandatory** → deny (400 or 403 per API style guide).

### Wildcard handling

- **No NULL `store_id` row** in assignments (section 2).
- **Wildcard:** Implemented as **resolver logic**: e.g. role flag `claims.scope.all_stores` **plus** org setting `tenant_admin_all_stores = true` **or** platform policy. Every **mutation** must still log the **concrete `store_id`** affected.

---

## 5. Access level semantics (`view` | `act` | `submit`)

| Level | Meaning |
|-------|---------|
| `view` | Read claims/inbox/case/task/event for the store; no mutations. |
| `act` | Create/update workflow objects, upload evidence (non-marketplace-sensitive), assign/reassign tasks, case lifecycle **except** marketplace submit and critical overrides. |
| `submit` | Includes marketplace **open / submit / follow_up** when paired with `claims.marketplace.*` keys; implies ability to perform channel filing. |

### Inheritance (ordering)

**`submit` ≥ `act` ≥ `view`** for satisfaction checks:

- A user with `submit` on a store satisfies permission keys that require `act` or `view` **for that store**, unless a key explicitly requires only `view` (rare).
- A user with `act` does **not** satisfy `claims.marketplace.submit`.

---

## 6. Dangerous actions policy

| Action / class | Permission keys | Risk | Audit | Reason text | Second approval (future) |
|----------------|-----------------|------|-------|-------------|----------------------------|
| Marketplace submit | `claims.marketplace.submit` + `submit` | critical | required | recommended | optional MFA / dual control |
| Open case / follow-up | `claims.marketplace.open_case`, `follow_up` + `submit` | high | required | recommended | optional |
| Evidence delete | `claims.evidence.delete` + `act` or higher | critical | required | **required** | recommended |
| Force close case | `claims.case.close` | high | required | recommended | optional for high-value |
| Reopen reimbursed | `claims.case.reopen` (+ future financial key) | high | required | **required** | recommended |
| PIM override | `claims.pim.override_block` | critical | required | **required** | recommended |
| Merge / duplicate override | `claims.workflow.admin` (+ future merge key) | critical | required | **required** | recommended |

**API behavior:** Prefer **403** vs **404** policy per route (document per surface) to reduce existence leakage for unauthorized IDs.

---

## 7. AI boundary rules

- **No auto-submit:** AI principals or jobs must **never** hold or use `claims.marketplace.submit` without a **human** approval step recorded in audit.
- **No silent lineage repair:** AI must not mutate `claim_candidates` or `source_row_id` or any immutable detection fields.
- **Logging:** All AI generations and applies emit **`claim_events`** (or pre-table security audit) with `actor_type = ai_agent` / human as appropriate; include `metadata.model`, `metadata.prompt_hash` (not raw secrets).
- **Human approval:** `claims.ai.apply_suggestion` only **proposes** application; applying to durable state requires the **same** permissions as if the user performed the action manually (e.g. draft text apply vs marketplace submit).

---

## 8. Migration readiness checklist

Before **`user_store_assignments` migration**, **`assertClaimPermission`**, **`claim_cases` / `claim_tasks` / `claim_events`**, or **workflow writes**:

- [ ] This document reviewed and **version frozen** (v1 tag or PR approval).
- [ ] **Access model** agreed: table name, columns, soft revoke, FK delete policy.
- [ ] **Permission catalog v1** frozen (section 3); additions require v2 bump.
- [ ] **Wildcard policy** agreed: tenant admin all-stores default (**recommended default: off**), platform impersonation rules.
- [ ] **Tenant admin behavior** documented for production vs dev.
- [ ] **Audit expectations** agreed: assignment CRUD, permission denials, AI events (section 6–7).
- [ ] **Test matrix** agreed: cross-org, cross-store, expired assignment, auditor read-only, marketplace without `store_id` must fail.

---

## 9. Recommended implementation order

1. **`user_store_assignments` migration** (after signoff of this spec; no workflow tables yet).
2. **`assertClaimPermission`** (reads assignments + role bundles; deny-by-default).
3. **Read APIs** — e.g. scoped store list for current user; optional permission probe for UI.
4. **Workflow tables** — `claim_cases`, `claim_tasks`, `claim_events` (migrations per architecture plans).
5. **Workflow write APIs** — transactional writes + events.
6. **Assignment UI** — admin management of `user_store_assignments`.
7. **AI assist** — suggestions + apply path under AI rules (section 7).
8. **Marketplace automation** — last; always `store_id` + server credentials.

---

## 10. Do-not-touch reminders

- No **org-only** marketplace actions — **`store_id` mandatory** for `claims.marketplace.*`.
- No **workflow state** on **`claim_candidates`** (immutable detection layer).
- No **AI auto-submit**; no **silent lineage repair**.
- No **marketplace secrets** in UI or client logs; credentials remain server-side.

---

## 11. Role examples (illustrative bundles)

> **Note:** Exact bundles are product decisions; below is a **reasonable default** for engineering discussion. Final bundles live in a future “role permission matrix” appendix.

### Operator (warehouse)

- **Assignments:** `view` (and possibly `act`) on **one or few** stores.
- **Allowed:** `claims.inbox.view`, `claims.case.view`, `claims.task.view`, `claims.task.claim`, `claims.task.complete`, `claims.evidence.upload` (with store context).
- **Denied:** `claims.marketplace.*`, `claims.pim.override_block`, `claims.workflow.admin`, `claims.case.reopen` (unless explicitly granted), `claims.evidence.delete`.

### Store manager

- **Assignments:** `act` or `submit` on **managed stores** only.
- **Allowed:** operator-allowed set + `claims.case.assign`, `claims.task.reassign`, `claims.case.close`, optionally `claims.marketplace.open_case` / `follow_up` if `submit` granted.
- **Denied without extra grant:** `claims.workflow.admin`, `platform.claims.*`, cross-store assign unless wildcard + policy.

### Tenant admin

- **Policy-dependent:** If `tenant_admin_all_stores` is **false**, same as store manager but with **`act` on all stores** via explicit rows **or** narrow wildcard. If **true**, resolver wildcard (section 4) with **mandatory audit** on mutations.
- **Allowed:** broad workflow + `claims.settings.manage`, `claims.pim.override_block` (with audit), still **no** `platform.claims.*` unless platform role.
- **Denied:** `platform.claims.impersonate_read` unless platform staff.

### Platform auditor

- **Platform grants:** `platform.claims.audit`, optionally `platform.claims.impersonate_read` under strict policy.
- **Allowed:** read-only views across orgs per policy; `claims.event.view`.
- **Denied:** all `claims.marketplace.submit`, `claims.evidence.delete`, `claims.workflow.admin` on tenant unless explicitly separated.

### Allowed / denied quick reference

| Request | Operator (view+act, Store A) | User no assignment Store A |
|---------|------------------------------|-----------------------------|
| View inbox Store A | Allowed if `view` | Deny |
| Upload evidence Store A | Allowed if `act` | Deny |
| Submit marketplace Store A | Deny (no `submit`) | Deny |
| Submit marketplace Store B | Deny (wrong store) | Deny |

---

## Unresolved decisions (explicit)

1. **`profile_store_access` vs `user_store_assignments` table name** — v1 standardizes on **`user_store_assignments`**; rename only if product/legal demands.
2. **HTTP 403 vs 404** policy per route family for anti-enumeration.
3. **Materializing** wildcard “all stores” into rows for performance vs pure resolver expansion.
4. **Optional DB constraint** that `profiles.organization_id` matches `user_store_assignments.organization_id` for `profile_id` — not enforced in NEXT-CLAIM-30 (application / follow-up migration).

---

## Recommended next implementation slice

After signoff of this document:

1. **`user_store_assignments` migration** — shipped as `supabase/migrations/20260812120000_user_store_assignments.sql` (NEXT-CLAIM-30); still no workflow tables and **no seed rows**.
2. **Wire `assertClaimPermission`** and read APIs against this table (avoid drift with service-only paths).

Until signoff: **documentation-only** changes to this file via PR review.
