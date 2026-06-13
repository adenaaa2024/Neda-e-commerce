# Task Center — UI & API contract V1 (Neda handoff)

**Phase:** `PHASE-TASK-CENTER-SCHEMA-VERIFY-AND-NEDA-UI-CONTRACT-V1`  
**Schema:** Phase 7A applied on staging `eiqfaapyumhixxoeltgu`  
**Mode:** Read-only frontend + proposed read API — no writes, no migrations, no scanner touch

TypeScript contracts: `lib/task-center/`

---

## Schema verification

| Check | Result |
|-------|--------|
| `task_items` exists | PASS |
| `task_comments` exists | PASS |
| `task_watchers` exists | PASS |
| `task_activity_log` exists | PASS |
| `groups.group_type` exists | PASS |
| `groups.parent_group_id` exists | PASS |
| RLS enabled (all 4 task tables) | PASS |
| service_role ALL policies | PASS (×4) |
| authenticated SELECT org-scoped only | PASS |
| No authenticated INSERT/UPDATE/DELETE | PASS |
| Indexes (14 + group indexes) | PASS |
| Rollback SQL exists | PASS |
| Cross-org read test | PASS |
| Scanner files changed | PASS (none) |
| Platform Access files changed | PASS (none) |
| `task_items` row count | **0** (no seed) |
| Build | PASS |

Evidence: `.cursor/audit-reports/phase-task-center-schema-verify-neda-ui-contract-v1/`

---

## Frontend data contract

### 1. Task Center Home (`/task-center`)

**API:** `GET /api/task-center/summary`

| KPI tile | Query semantics |
|----------|-----------------|
| Open tasks | `deleted_at IS NULL` AND `status IN (open, in_progress, blocked, waiting)` |
| Assigned to me | above + `assigned_user_id = current_profile_id` |
| Assigned to my groups | above + `assigned_group_id IN (user_groups.group_id[])` |
| Overdue | above + `due_at < now()` |
| Due soon | above + `due_at BETWEEN now() AND now() + 7 days` |
| Blocked | above + `status = blocked` |
| Source module summary | group by `source_module` with same active filter |

**UI sections:** KPI tiles → My open (top 5) → Attention list (deduped) → Source summary chips

**Empty state:** "No tasks yet" + write phase notice (not an error — table is empty post-7A)

### 2. My Tasks (`/task-center/my`)

**API:** `GET /api/task-center/tasks?assigned_user_id={me}&status=open,in_progress,blocked,waiting`

| Grouping | Field |
|----------|-------|
| Overdue | `due_at < now()` |
| Due today | same calendar day |
| This week | within 7 days |
| Later | `due_at > 7d` or null |
| Secondary | `priority` DESC, then `created_at` DESC |

### 3. Team / Queue (`/task-center/team`, `/task-center/team/[groupKey]`)

**API:** `GET /api/task-center/tasks?assigned_group_id=` / `GET /api/task-center/groups`

| Filter | Field |
|--------|-------|
| Queue workload | `assigned_group_id` |
| Group type | `groups.group_type`: team \| department \| queue \| access_group |
| Tree | `groups.parent_group_id` → `buildTaskCenterOrgTree()` |

### 4. Source Work (`/task-center/sources/*`)

**API:** `GET /api/task-center/source-summary`, `GET /api/task-center/tasks?source_module=`

| Route | `source_module` |
|-------|-----------------|
| `/sources/scanner` | `scanner` |
| `/sources/claims` | `claims` |
| `/sources/product` | `product` |
| `/sources/automation` | `automation` |
| `/sources/warehouse` | `warehouse` |
| `/sources/admin` | `platform` (UI label **Admin**) |

Scanner sub-filters: see `TASK_CENTER_SCANNER_UI_SOURCE_KINDS` in `task-center-scanner-source-display-contract.ts`

### 5. Task Detail (`/task-center/[taskId]`)

**API:** `GET /api/task-center/tasks/[id]`

| Section | Source |
|---------|--------|
| Title, status, priority, due | `task_items` |
| Source snapshot | `source_snapshot` JSONB |
| Assignment | `assigned_user_id`, `assigned_group_id` + profile/group joins |
| Comments | `task_comments` WHERE `deleted_at IS NULL` |
| Watchers | `task_watchers` + profile names |
| Activity log | `task_activity_log` ORDER BY `created_at` |
| Status timeline | derived from activity where `event_type IN (status_changed, blocked, unblocked, completed, …)` |
| Source link | read-only deep link from `source_snapshot.deep_link_href` or resolver — **never** scanner mutation routes |

Desktop: right drawer · Mobile: full page · Footer: `TaskCenterWriteGateFooter` (all actions disabled)

### 6. Org Structure (`/task-center/org`)

**API:** `GET /api/task-center/groups`, `GET /api/task-center/groups/[id]`

| Display | Source |
|---------|--------|
| Read-only tree | `groups` + `parent_group_id` |
| Group type badge | `group_type` |
| Users in group | `user_groups` + `profiles` (read-only preview) |
| Manage link | `/platform/access` (external) — **no inline RBAC editing** |

---

## Route map

See `TASK_CENTER_ROUTES` in `lib/task-center/task-center-ui-contract.ts`

---

## Component map

See `TASK_CENTER_COMPONENT_MAP` and `TASK_CENTER_PAGE_FILES` in `lib/task-center/task-center-ui-contract.ts`

Pattern reference: Claim Center (`ClaimCenterAppShell`, `MenorixModuleAppShell`, phase notices)

---

## API contract (read-only first)

| Route | Purpose |
|-------|---------|
| `GET /api/task-center/summary` | Home KPIs + attention ids |
| `GET /api/task-center/tasks` | Filtered list + cursor pagination |
| `GET /api/task-center/tasks/[id]` | Detail + comments + watchers + activity |
| `GET /api/task-center/groups` | Flat list + tree + my_group_ids |
| `GET /api/task-center/groups/[id]` | Group detail + members (optional v1) |
| `GET /api/task-center/source-summary` | Per-module open/overdue/blocked counts |

**Implementation rules:**
- `supabaseServer` (service_role) only
- Assert session org matches requested org
- Never expose client-side Supabase writes
- Return `read_only: true` on all payloads until Phase 7B

---

## Scanner source display contract

Future filters only — **do not create scanner tasks**, **do not change scanner UI**.

See `lib/task-center/task-center-scanner-source-display-contract.ts`

- Allowed `source_entity_type` values documented
- UI source kinds map to entity types for filter chips
- `source_snapshot` render contract for box/pallet/shipment context
- Product rows: hydrate `ProductLinkageDisplayContract` when present
- Deep links: returns/PIM read routes only — not `app/scanner/operator-mobile/**`

---

## Org structure display contract

See `lib/task-center/task-center-org-display-contract.ts`

- Reuses `groups`, `user_groups` — no teams/departments tables
- `group_type` + `parent_group_id` tree
- Platform Access owns edits

---

## Deferred write actions (Phase 7B)

See `TASK_CENTER_DEFERRED_WRITE_ACTIONS` in `lib/task-center/task-center-api-contract.ts`

All write UI shows: *"Task write phase required (Phase 7B approval)."*

---

## Neda files to create

**Lib (done in this phase):**
- `lib/task-center/*` — schema, API, UI, scanner, org contracts

**Next scaffold phase:**
- `components/task-center/**` — see component map
- `app/task-center/**` — see page files
- `app/api/task-center/**` — read routes (after or with scaffold)
- `scripts/phase-task-center-ui-readonly-verify.ts`

**Extend:**
- `lib/sidebar-config.ts` — Task Center leaf
- `lib/menorix/module-app-contracts.ts` — align tiles to route map

---

## Neda no-touch files

- `app/scanner/operator-mobile/**`
- `lib/scanner/**` (display constants import OK)
- `app/platform/access/**`
- `app/returns/actions.ts`, product resolver modules
- `supabase/migrations/**`

---

## Gates

| Gate | Value |
|------|-------|
| **SAFE_FOR_NEDA_FRONTEND** | **yes** |
| **NEXT_PROMPT_FOR_NEDA** | `PHASE-TASK-CENTER-UI-READONLY-SCAFFOLD-V1` |

Implement Menorix shell + read API routes + empty states against live schema. No write buttons enabled.
