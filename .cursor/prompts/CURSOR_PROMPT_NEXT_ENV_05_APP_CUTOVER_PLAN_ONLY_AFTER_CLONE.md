# NEXT-ENV-05 — APP CUTOVER PLAN (ONLY AFTER CLONE PASS)

## Owner
Main/user

## Mode
Plan (no cutover execute unless explicitly approved)

## Prerequisite
**NEXT-ENV-04** Postgres clone **PASS** + staging verification counts match original (within expected tolerance).

## Goal
Document-only cutover plan:
- `NEXT_PUBLIC_SUPABASE_URL` / anon / service role migration steps
- Vercel env var checklist
- Rollback plan
- Smoke test checklist on staging **before** cutover
- ENV-06 execute gate (future)

## Hard constraints

- **Do not** switch app to staging in this prompt unless operator adds explicit EXECUTE approval
- **Do not** touch production
- **Do not** create `package_items`
- **Do not** run production probes

## Forbidden until separate approval

- Vercel production deploy with staging URL
- DNS / domain changes
- Decommissioning original

## Output
`.cursor/audit-reports/next-env-05/<run_id>/`

Artifacts: `cutover-plan.md`, `rollback-plan.md`, `smoke-checklist.md`, `manifest.json`

## After plan
Append history via `CURSOR_PROMPT_GENERATE_HISTORY_V162.md`
