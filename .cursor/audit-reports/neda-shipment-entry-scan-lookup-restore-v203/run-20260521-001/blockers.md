# Blockers

## None for code restore

Implementation is complete in-repo. No DDL approval required for V203 path.

## Environment / validation blockers

| Blocker | Impact | Mitigation |
|---------|--------|------------|
| Supabase env not set in CI agent | DB smoke steps skip | Run `neda-shipment-entry-scan-lookup-restore-v203.ts` locally with `NEXT_PUBLIC_SUPABASE_URL` + service key |
| SAM org/store UUIDs may not match deployment | tracking/package smoke FAIL | Set `NEDA_SMOKE_ORG_ID` / `NEDA_SMOKE_STORE_ID` to live Sam store |
| Browser proof not run in this session | No screenshot artifact | Operator replay on `/scanner/operator-mobile/scan` with known carton barcode |

## Optional follow-up (not blocking)

- Add `package_code` to `v_inventory_item_status` via approved migration for single-query gate
- Server action wrapper if client Supabase reads must be removed policy-wide
