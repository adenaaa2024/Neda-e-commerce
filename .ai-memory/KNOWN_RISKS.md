# Known risks

**Last updated:** 2026-05-26 (canonical memory rebuild)

## Highest severity

| Risk | Impact | Mitigation |
|------|--------|------------|
| **38 dirty expected_packages identifiers** | Wrong map/API/auto-link if executed before quarantine | PC07-EXEC + quarantine plan; no blind resolver |
| **Migration commit gap (PC06A)** | Drift between repo migrations and live DDL (V193, V205, PC04) | Commit operator DDL from audit artifacts before new applies |
| **Original DML without PC07 dry-run** | Data corruption if staging UUIDs copied | Re-run dry-run per wave on original; separate approvals |

## Product / linkage

| Risk | Detail |
|------|--------|
| 43 unresolved expected_packages | 38 dirty + 5 API 404 — blocks canonical coverage |
| slip_contents 11/11 unresolved | manual_review only — no auto promotion |
| return_items 7/7 unresolved (PC01 read-layer) | Separate from V189 test-cohort closure (3 active resolved) |
| AFI 4,751 unresolved | Large catalog program — do not mix with EP dirty queue |
| Title/OCR/fuzzy product create | **Forbidden** — contract guard V192 |

## Integrations

| Risk | Detail |
|------|--------|
| PC02 approval false | Governed Amazon HTTP blocked; env flags must stay safe |
| SP-API 404 cohort | 5 rows need manual ASIN correction (PC02C) |
| Browser / fake SP-API truth | Forbidden as product source |

## Claims

| Risk | Detail |
|------|--------|
| 0.4% execute readiness | No live repoint / destructive cleanup |
| missing_product ~7,190 | Regeneration blocked until Wave B + spine stable |
| missing_source_row ~1,543 | Source orphan cleanup required |

## Environment

| Risk | Detail |
|------|--------|
| Env quartet drift | Neda/local must stay on staging ref |
| Vercel Preview 401 | Deployment Protection — DB wiring PASS; HTTP needs bypass/signoff |
| Future production | NOT_CREATED_YET — do not treat original as “prod cutover done” |

## Parity

| Risk | Detail |
|------|--------|
| Staging-only spine DML | Original behind until PC07 waves |
| Packaging backfill staging-only | Claims needing dimensions may reference staging profiles only |

## AI

Default deny — no autonomous product resolution or external HTTP without explicit gates.
