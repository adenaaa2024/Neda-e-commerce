# Scanner compatibility check

## Scope

Code-level compatibility after NEXT-SCANNER-02 (no extended default selects wired per prior audit). This run did **not** mutate scanner flows.

## Build / typecheck

- `npx tsc --noEmit`: **pass**
- `npm run build`: **pass** (Next.js 16.1.7; loads `.env.local`)

## Runtime vs database

Until the migration is applied on a given Supabase project, PostgREST PATCH/select paths that reference the new columns may log errors or no-op as documented in NEXT-SCANNER-02 `blockers.md`. No code change was made here to widen default reads.

## Legacy table reference grep

- `.from("returns")` / `` .from(`returns`) `` in `app/**/*.tsx` and `lib/**/*.ts`: **no matches**

## Scanner smoke

**Not run** — no confirmed non-production DB with migration applied; no automated scanner E2E script was invoked in this run.
