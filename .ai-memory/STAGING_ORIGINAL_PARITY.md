# Staging / original parity

**Last updated:** 2026-05-28 (`original-parity-wave-data-resolver-finish-verify` `20260528T220000Z`)

## Refs

| Role | Ref |
|------|-----|
| Staging | `eiqfaapyumhixxoeltgu` |
| Original / current | `kxsvedvpjldygtdbylsy` |
| Future production | `NOT_CREATED_YET` — **BLOCKED** |

## Production readiness

| Surface | Ready |
|---------|-------|
| Original / current | **PARTIAL** — data wave + resolver complete; **2,413** missing_product_needs_evidence; Wave B map replays optional |
| Staging phase1 scanner/removal | **YES** for governed staging proofs |

## Schema wave (original) — PASS

**Evidence:** `original-parity-phase1-wave-schema-execute/20260530T180000Z/`

| Check | Result |
|-------|--------|
| Migrations applied | **4 / 4** on `kxsvedvpjldygtdbylsy` |
| Functions present | **PASS** |
| Views parity | **PASS** |
| Grouped rebuild | **PASS** |
| Smoke | **PASS** |

## Data wave (original) — EXECUTED

| Item | Status |
|------|--------|
| Execute | **PASS** — `original-parity-phase1-wave-data-execute/20260528T201200Z/` |
| Resolver finish verify | **PASS** — `original-parity-wave-data-resolver-finish-verify/20260528T220000Z/` |
| Strategy | Fresh SP-API fetch → domain sync → rebuild → resolver (no staging clone) |
| `rebuild_valid` | **yes** (non-overflow mismatch **0**) |
| Staging copy | **FORBIDDEN** — not used |

## Staging vs original counts (live)

| Metric | Staging | Original |
|--------|--------:|---------:|
| derived `expected_packages` | **6,175** | **11,790** |
| EP resolved | **6,099** | **9,377** |
| EP unresolved (derived, no product_id) | **76** | **2,413** |
| status=ambiguous (derived) | **0** | **0** |
| `dimensions_current` | 571 | 571 |

Original has more domain rows (9-month fetch); staging has higher **%** resolved on a smaller cohort (~98.8% vs ~79.5%).

## Build / deploy gate

`npm run build` fails on `tesseract.js` / `scan/page.tsx` — fix before deploy merge.

## Exact next prompt

**ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE** — governed map replays on original to close `missing_product_needs_evidence` gap (optional before Wave C scanner verify)

Detail: [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) · [SCANNER_STATE.md](SCANNER_STATE.md)
