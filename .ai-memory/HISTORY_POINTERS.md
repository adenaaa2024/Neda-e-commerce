# History pointers — authoritative

Do not paste full history into `.ai-memory`. Use modular memory + master file.

## Canonical master (append-only)

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Rebuild | `20260526T180000Z` |
| Latest append | `20260527T200000Z` — packaging Wave2 closeout: 441/441 both refs; PC05F verify PASS |
| Living summary | Sections **1–17** at top |
| Archive | V182 + V178–V196 + PC01 + packaging parity slices below (immutable) |

**Read order:** Master §1–17 → [CURRENT_STATE.md](CURRENT_STATE.md) → domain files → phase audit folder.

## Latest phase — PC Phase 01

```
.cursor/audit-reports/history-pc-phase-01/20260526T120000Z/ERP_PIM_FULL_HISTORY_PC_PHASE_01_APPEND_ONLY_PRODUCT_CANONICALIZATION.md
```

Closeout: `history-memory-pc-phase-01-closeout/20260526T120000Z/`

## Canonical full base — V182

```
.cursor/audit-reports/history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md
```

Embedded in later operator files; still the deepest V87–V181 narrative.

## Modular memory (this rebuild)

| File | Topic |
|------|-------|
| [CURRENT_STATE.md](CURRENT_STATE.md) | Gates snapshot |
| [ROADMAP.md](ROADMAP.md) | Priorities |
| [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) | Unresolved counts + resolver |
| [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) | Views + operator-mobile |
| [SP_API_STATE.md](SP_API_STATE.md) | Evidence-only SP-API |
| [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md) | Pilot + W1 + W2 **CONFIRMED**; 441 `dimensions_current` |
| [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md) | PC05 census |
| [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) | PC06 + packaging waves |
| [MIGRATION_LEDGER.md](MIGRATION_LEDGER.md) | DDL/DML ledger |
| [KNOWN_RISKS.md](KNOWN_RISKS.md) | Blockers |

**Memory rebuild audit:** `shared-ai-memory-rebuild-canonical/20260526T200000Z/`

## Prior era pointers (archive)

| Era | Path |
|-----|------|
| V189 return_items closure | `history-v189/20260524T140000Z/` |
| V183 Neda + FBM dry-run | `history-v183/20260520T230000Z/` |
| V206 package_code | `history-v206/20260522T240000Z/` |

## PC audit evidence (quick)

| Area | Path |
|------|------|
| PC01 | `pc01-product-canonicalization-baseline/20260522T230000Z/` |
| PC02A/B/C | `pc02a-*` · `pc02b-*` · `pc02c-*` |
| PC03B | `pc03b-expected-packages-source-disagreement-map-execute/20260523T020000Z/` |
| PC04A/B | `pc04a-*` · `pc04b-*` |
| PC05 | `pc05-claim-engine-readiness-census/20260525T180000Z/` |
| PC05C staging scale | `pc05c-product-packaging-backfill-scale-staging/20260523T220100Z/` |
| PC05C original parity | `pc05c-packaging-original-data-parity-execute/20260526T180000Z/` |
| PC05D Wave1 | `pc05d-wave1-packaging-scale-staging-execute/20260526T190000Z/` |
| PC05D Wave2 | `pc05d-wave2-packaging-scale-staging-execute/20260526T202000Z/` · `pc05d-wave2-review-census-staging/20260526T203000Z/` · `pc05d-wave2-activate-staging/20260526T204000Z/` |
| PC05E Wave1 original | `pc05e-wave1-original-parity-execute/20260526T200000Z/` |
| PC05F Wave2 original | `pc05f-wave2-original-parity-plan/20260526T210000Z/` · `pc05f-wave2-original-parity-execute/20260526T211000Z/` · `pc05f-wave2-original-verify/20260526T212000Z/` |
| PC06 | `pc06-db-parity-ledger-original-sync-plan/20260526T040000Z/` |

## Paired-update law

Append-only history + `.ai-memory` updated **together** in one session. Do not delete or summarize away prior history slices.

## Legacy memory (preserved)

[PRODUCT_ID_MAPPING_STATUS.md](PRODUCT_ID_MAPPING_STATUS.md) · [NEDA_HANDOFF.md](NEDA_HANDOFF.md) · [TRID_CLAIM_STATUS.md](TRID_CLAIM_STATUS.md) · [ENVIRONMENT_TOPOLOGY.md](ENVIRONMENT_TOPOLOGY.md)
