# Commands reference — V176

Common npm scripts from audits. Run from repo root.

## Build & lint

```bash
npm run build
npm run lint
```

## Product linkage tests

```bash
npm run test:product-linkage-display-contract
npm run test:scanner-product-linkage-ui
```

## Environment / operable smokes

```bash
npm run smoke:operable-signoff-pim-store-context-v173
npx tsx scripts/manual-ui-operable-browser-smoke-v173.ts --manual-login --headed
```

Preview (operator):

```bash
SMOKE_BASE_URL=https://ecommerce-os-git-integrat-ec746a-mebrahimipargoo-9799s-projects.vercel.app \
  npx tsx scripts/manual-ui-operable-browser-smoke-v173.ts --manual-login --headed
```

## Product mapping

```bash
npm run smoke:product-id-mapping-v174
npm run smoke:product-id-mapping-wave-2-v176
```

## Schema combined smoke (V175)

```bash
npm run dev   # separate terminal
npm run smoke:schema-product-combined-v175
# or
npx tsx scripts/schema-product-combined-smoke-v175.ts --run-id=<id> --reuse-auth
```

## TRID / claims

```bash
npm run verify:trid-v170-staging
npm run verify:claim-trid-read-path-v171
npm run verify:claim-candidate-resolver-v175-staging -- --candidates-only --run-id=<id>
npm run verify:claim-candidate-resolver-v175-staging -- --candidates-only --run-id=<id> --execute
```

## Scanner staging

```bash
npm run smoke:scanner-02f-preflight
npm run smoke:scanner-02g-app
npm run smoke:scanner-02i-db-verify -- --run-id=<id>
```

## Dev utilities

```bash
npm run dev
npm run sync:sidebar
```

## Forbidden command patterns

- Any script with `production` in name without explicit approval
- Raw SQL against original ref for writes during integration work
- `supabase db push` to production (blocked)
