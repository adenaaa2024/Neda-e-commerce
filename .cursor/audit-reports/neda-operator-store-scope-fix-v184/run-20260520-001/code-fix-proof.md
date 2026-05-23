# Code fix proof

## Files changed

| File | Change |
|------|--------|
| `app/scanner/operator-mobile/_components/OperatorSessionStoreProvider.tsx` | Workspace `localStorage` wins over `UserRoleContext.organizationId`; do not clear workspace id before profile loads; hydrate `sessionStoreId` from per-org LS before server scope; defer store fetch until `profileLoading` is false |
| `components/UserRoleContext.tsx` | Same-tab `WORKSPACE_ORGANIZATION_CHANGED_EVENT` listener keeps `superAdminOrganizationOverride` in sync |

## Why test3 / no-store appeared

1. Staging auth user (`c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc`) home org **RECOVRA** has **0** active stores.
2. Sam Distribution (`00000000-0000-0000-0000-000000000001`) has **Sam AM** (`509ee1f6-622c-46a5-8110-7b889ba46c2c`) with EP/inventory data.
3. Operator provider preferred context org and briefly cleared workspace LS while `sessionCanWorkspaceSwitch` was still false → RECOVRA scope + empty store list + stale identify-gate error text.

## No DB writes

See `db-membership-approval-plan.md` for optional profile org change (not executed).
