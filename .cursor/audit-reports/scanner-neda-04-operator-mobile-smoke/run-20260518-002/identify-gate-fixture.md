# Identify gate fixture

## Fixture (read-only, latest package with tracking)

| Field | Value |
|-------|-------|
| `package_id` | `9528d923-3d27-4aed-a773-095b5028743d` |
| `organization_id` | `7397edff-7994-4731-8501-55d258d507d2` |
| `store_id` | `9adfe198-7c6a-49a5-b0b4-d370a83de06f` |
| `tracking_number` | `123` |
| `package_code` | `1231` |
| `slip_contents` rows | 2 |
| `return_items` rows | 0 |
| `expected_packages` (tracking match) | 0 |

## Identify gate

- **EP_SELECT** / **EP_DETAIL_SELECT** probes: **OK** (no 42703).
- Tracking `123` does not match inventory expectation rows on linked DB — identify gate **match path not exercised** end-to-end in this run.

## Operator manual check (recommended)

1. Sign in as operator/super_admin with org `7397edff-…`.
2. Open `/scanner/operator-mobile/scan`, enter a tracking that exists in `expected_packages` for the active store.
3. Confirm gate transitions `idle` → `matched` without console/network 42703.

## Conclusion

**Partial** — schema-safe; fixture lacks EP rows for full gate match demo.
