# Blockers

## None for package_items repair smoke

The operator-mobile item-scan path is unblocked relative to neda-03 goals.

## Non-blocking follow-ups

1. **Identify gate E2E** — linked DB fixture tracking `123` has no `expected_packages` rows; use a known EP tracking for manual gate match.
2. **Slip linkage columns** — live DB missing `slip_contents.notes` and scanner linkage fields; UI uses select fallback (attempt 6/6). Consider migration apply + re-probe (scanner-neda-02).
3. **Extended EP selects** — `identifier_resolution_status` on `expected_packages` still 42703; does not break current `EP_SELECT` identify path.
4. **Save round-trip** — not executed in audit (write constraint); operator should save one unit and reload to confirm hydration.
