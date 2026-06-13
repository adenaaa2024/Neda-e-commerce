# Task Center — architecture note

**Status:** Schema applied on staging (Phase 7A). UI scaffold pending.

## Purpose

Organization-wide work management: teams, departments, roles, tasks, assignment, comments, due dates, priorities — with permission-aware visibility and deep links to claims, products, returns, and automation errors.

## Core entities

| Entity | Scope | Notes |
|--------|-------|-------|
| `groups` (+ `group_type`, `parent_group_id`) | organization_id | Reuses RBAC groups for access_group / team / department / queue |
| `task_items` | organization_id + optional store_id | Module-linked work units |
| `task_comments` | task_id | Activity thread |
| `task_watchers` | task_id + profile_id | Followers |
| `task_activity_log` | task_id | Append-only audit |

**Not created:** separate `teams`/`departments` tables, `task_assignments`, `notifications`, `task_boards`.

All tables require `organization_id NOT NULL` on `task_items`; soft-delete via `deleted_at`.

## RLS (Phase 7A)

- RLS enabled on all task tables
- `service_role`: ALL
- `authenticated`: SELECT only, org-scoped via `get_my_organization_id()`
- Child tables: SELECT via `EXISTS` join to parent `task_items`
- No client writes in Phase 7A

## Surfaces

| Surface | Desktop | Mobile |
|---------|---------|--------|
| My tasks | Command home + table/board toggle | Task cards + bottom nav |
| Team board | Group queue table | Swipeable priority cards |
| Module-linked tasks | Filter by source module (claims, returns, automation, scanner) | Filter sheet |
| Task detail | Right drawer | Full-screen sheet + sticky actions (read-only until write phase) |

## Integration points

- **Claims:** tasks opened from `claim_cases` review holds, evidence gaps, reference conflicts
- **Products:** linkage resolution follow-ups
- **Returns:** disposition and QC exceptions
- **Automation:** failed cron/generator runs from Automation Center
- **Scanner:** future bridge deferred — `source_module='scanner'` allowed; no scanner UI changes
- **AI Center:** assistive task summary only — never auto-complete

## Permissions

- Task visibility filtered by role + group membership + store scope (`user_store_assignments`)
- Platform Access / RBAC editing stays in `/platform/access` — not Task Center

## Module gate

- Future `task_center` entitlement
- Locked `MenorixModuleFeatureLockedCard` when disabled

## Menorix pattern mapping

Uses full Module App Pattern: `MenorixModuleAppShell`, board/table view switcher, mobile cards, phase notices for write gates.

See `lib/menorix/module-app-contracts.ts` → `TASK_CENTER_MODULE_CONTRACT`.

## Staging apply

- Migration: `supabase/migrations/20260919120000_phase7a_task_center_schema_staging_rls_gated.sql`
- Rollback: `supabase/migrations/rollback/20260919120000_phase7a_task_center_schema_staging_rls_gated_rollback.sql`
- Evidence: `.cursor/audit-reports/phase7a-task-center-schema-staging-verify/20260612T024718Z/`
