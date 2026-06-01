# Codex rules — V176

Codex-specific constraints on top of [AGENTS.md](../AGENTS.md).

## Session start

1. Load `.ai-memory/CURRENT_STATE.md` and `FORBIDDEN_ACTIONS.md`.
2. Confirm active DB ref from user env — default expectation is **staging** `eiqfaapyumhixxoeltgu`.
3. Do not assume Preview HTTP works without auth.

## Editing

- Match existing TypeScript patterns in `lib/` and `components/`.
- Product linkage changes must go through `ProductLinkageDisplayContract` mapper — no one-off display shapes.
- Prefer extending existing scripts under `scripts/` over new ad-hoc one-offs.

## Testing / verification

- Build: `npm run build`
- Contract: `npm run test:product-linkage-display-contract`
- Combined smoke (needs dev server): `npm run smoke:schema-product-combined-v175`

## After major audits (paired update)

Follow [HISTORY_POINTERS.md](HISTORY_POINTERS.md): **always** update the canonical append-only full history **and** `.ai-memory` in the **same session**. Never commit memory to only one side. Then align `TASKS.md`.

## Commits

- Do not commit unless user asks.
- Never commit secrets or `.cursor/audit-reports` bulk unless user wants audit artifacts tracked.

## Escalate to user

- Production registration or cutover
- Amazon API enablement
- OpenAI / live AI enablement
- Any `package_items` or `returns` table introduction
- Destructive SQL
