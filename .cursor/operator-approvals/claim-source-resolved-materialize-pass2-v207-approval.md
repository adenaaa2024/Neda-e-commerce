# Claim source-resolved materialize pass 2 — V207 operator approval

**Scope:** Second governed materialize after V206 `amazon_removal_shipments` source RPID cleanup.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-22` |
| V203–V206 | PASS |
| V205 baseline run | `20260522T210000Z` (412 applied) |
| V206 shipment cleanup | `20260522T220000Z` (4,714 valid source RPIDs) |
| Policy | `source_resolved` + `identifier_map` only; FK guard; no product auto-create |

## Forbidden

- Production, DELETE, claim submit, Amazon API

## Execute

`npx tsx scripts/claim-source-resolved-materialize-pass2-v207-staging.ts --run-id=<id> --execute`
