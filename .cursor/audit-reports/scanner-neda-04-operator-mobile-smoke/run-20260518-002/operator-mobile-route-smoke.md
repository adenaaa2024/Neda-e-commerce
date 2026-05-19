# Operator-mobile route smoke

## Route

`/scanner/operator-mobile/scan` → `app/scanner/operator-mobile/scan/page.tsx`

## Checks

| Check | Evidence |
|-------|----------|
| Page loads | `GET /scanner/operator-mobile/scan 200` (dev terminal) |
| Server actions respond | `POST /scanner/operator-mobile/scan 200` (store scope, slip list, package items list) |
| Build includes route | `npm run build` lists `ƒ /scanner/operator-mobile/scan` |
| Auth / org | Session super_admin, org hint `7397edff-7994-4731-8501-55d258d507d2` in dev logs |

## Probe script

`npx tsx scripts/scanner-neda-04-operator-mobile-smoke.ts` — read-only; writes `probe-output.json` in this run folder.
