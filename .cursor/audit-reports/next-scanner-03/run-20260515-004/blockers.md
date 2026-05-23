# Blockers

## Active

1. **SCANNER-02b environment gate not cleared in audit** — Until dev/staging is explicitly confirmed and migration applied + verified, production rollout of extended selects remains a **deployment risk** (PostgREST column errors on unmigrated DBs).

## Cleared / informational

- TypeScript build (`tsc --noEmit`) passes with extended select wiring.
- No new dependency on Amazon, OpenAI, or claim submission paths for this feature set.

## Lint

- Targeted ESLint on touched paths still reports **pre-existing** errors inside `app/returns/_components.tsx` (React compiler `set-state-in-effect` rule). No new rule was introduced for the scanner review panel specifically.
