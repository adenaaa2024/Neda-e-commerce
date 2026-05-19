# Blockers — SCANNER-BACKEND-CONTRACT-SYNC-V165

**Run:** `run-20260518-001`  
**Contract status:** **PASS** (no release blockers for Neda wiring)

## None for core BOX / item-scan path

Live DB verification (read-only, project `kxsvedvpjldygtdbylsy`) confirms:

| Check | Result |
|-------|--------|
| `return_items` + linkage SELECT | OK |
| `slip_contents` list SELECT (fallback attempt 4) | OK |
| `package_items` table | Absent (PGRST205) — expected |
| Operator-mobile static: zero `package_items` refs | OK |
| Fixture hydrate + NEDA-06 smoke row | OK |

## Informational / out of scope (not blockers for this handoff)

1. **Staging clone (ENV-06)** — No separate staging project is wired in workspace env. Staging-only tests are documented in `staging-test-plan-after-clone.md`; do not switch app env until operator approves.

2. **`operatorReceiveItem` (expected_packages path)** — Still used on scan page for **tracking / EP expectation** receive flows. Neda BOX item scan should use `insertOperatorPackageItemAction` only. Mixing paths on the same UI step would double-count EP.

3. **`manualOverrideReturnItemProductResolution`** — Implemented and DB-safe; wired from **returns admin UI** (`app/returns/_components.tsx`), not operator-mobile scan. Neda can call it for manual product pick if product UI is added later.

4. **`insertOperatorUnknownPackageAction`** — Server action exists; scan page “unknown tracking” flow currently sets **client session state** without calling it (deferred package create). Safe fallback: operator continues in degraded session until box intake persists a `packages` row.

5. **Identify gate “matched” demo** — NEDA-09 noted tracking `123` has no EP match; gate idle→matched is environment/fixture dependent, not a contract defect.

6. **Slip linkage columns on read** — Full `RETURN_SCANNER_LINKAGE_SELECT` on `slip_contents` may require select fallback (attempt 4 without `order_id` / linkage on some DBs). Display badges degrade gracefully via `useScannerProductResolutionBadges`.

## Do not treat as blockers (explicitly forbidden)

- Missing `package_items` table
- `resolved_product_id` null after scan (no auto product create by design)
- `expected_packages.identifier_resolution_status` — column must not be used (see `forbidden-old-contracts.md`)
