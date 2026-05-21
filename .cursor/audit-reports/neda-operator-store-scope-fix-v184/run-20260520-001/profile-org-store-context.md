# Profile / org / store context (staging)

**Auth user:** `c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc` (Neda)
**Role:** super_admin

## Home org (profiles.organization_id)

- id: `39f5e74f-0690-4ad0-9edd-3a7f6dd7385b`
- name: RECOVRA
- active stores: **0**

## Sam tenant (workspace target)

- org: `00000000-0000-0000-0000-000000000001` — Sam Distribution Inc
- store: `509ee1f6-622c-46a5-8110-7b889ba46c2c` — Sam AM
- active stores: Sam AM

## Root cause

Signed-in super_admin home org is internal **RECOVRA** with zero active stores. Operator UI used
`UserRoleContext.organizationId` before `workspace_selected_organization_id`, so branding/store scope
could stay on home/test3 while SAM data lives under Sam Distribution.

## Code fix (no DB writes)

- `OperatorSessionStoreProvider`: workspace localStorage wins over context org; sync read on mount.
- `UserRoleContext`: listen for `WORKSPACE_ORGANIZATION_CHANGED_EVENT` in same tab.
