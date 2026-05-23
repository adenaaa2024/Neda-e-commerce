# Next step recommendation

## Immediate (ops / infra)

1. **Close SCANNER-02b gate** — Classify the Supabase project, apply `20260717120000_scanner_product_linkage_columns.sql`, run live column verification, and record a passing 02b run.

## Product / engineering — suggested prompt

**NEXT-SCANNER-04 — Post-migration verification + polish**

- Run end-to-end scanner smoke on staging: extended `SELECT`s, identify gate chips, item drawer override, audit log rows.
- Optional: add **expected_packages** manual override (separate audited action) if operators must correct planner lines without touching `return_items`.
- Optional: enrich `TrackingOperatorLine` with worst-case `identifier_resolution_source` for aggregated display.
- Triage ESLint `react-hooks/set-state-in-effect` in `app/returns/_components.tsx` in a dedicated hygiene PR (large file; avoid mixing with feature work).

## Exact next prompt (copy)

`NEXT-SCANNER-04 — STAGING E2E: VERIFY EXTENDED SELECTS + DRAWER OVERRIDE + AUDIT LOG; ADD OPTIONAL EP-LEVEL MANUAL OVERRIDE; DOCUMENT RLS CHECKS FOR products ↔ return_items. Prerequisites: passing scanner-02b run on the same Supabase instance.`
