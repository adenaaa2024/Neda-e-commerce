# Codex onboarding — ecommerce-os (V176)

Welcome. This repo uses a **shared AI memory** pack so you do not need prior chat context.

## 5-minute start

1. Read [`.ai-memory/CURRENT_STATE.md`](.ai-memory/CURRENT_STATE.md)
2. Read [`.ai-memory/FORBIDDEN_ACTIONS.md`](.ai-memory/FORBIDDEN_ACTIONS.md)
3. Read [`.ai-memory/CODEX_RULES.md`](.ai-memory/CODEX_RULES.md)
4. Skim [ARCHITECTURE.md](ARCHITECTURE.md) and [`.ai-memory/DATABASE_CONTRACT.md`](.ai-memory/DATABASE_CONTRACT.md)

## Environment

- **Work against staging:** `eiqfaapyumhixxoeltgu` via active quartet in `.env.local` (not `STAGING_*` aliases alone).
- **Never** set production vars to staging values.
- **Original** `kxsvedvpjldygtdbylsy` is live Vercel Production — treat as read-only unless user explicitly asks for production work (usually forbidden).

## Code conventions

- Product linkage UI: `ProductLinkageDisplayContract` only.
- Returns lines: `return_items` table — **never** `returns`.
- Packages: no `package_items` table or inserts.
- Resolvers: `scripts/claim-candidate-resolver-project-v175-staging.ts` patterns — deterministic tiers, no product auto-create.

## Commands

See [`.ai-memory/COMMANDS.md`](.ai-memory/COMMANDS.md) for npm scripts used in audits.

## Evidence

- Latest history: `.cursor/audit-reports/history-v175/20260604T120000Z/ERP_PIM_FULL_HISTORY_V175_APPEND_ONLY_CLAIM_RESOLVER_PREVIEW_STATUS.md`
- Bootstrap audit: `.cursor/audit-reports/ai-shared-memory-bootstrap-v176/20260519T223000Z/`

## When unsure

Stop and ask the user rather than running production migrations, Amazon API calls, or product auto-create.
