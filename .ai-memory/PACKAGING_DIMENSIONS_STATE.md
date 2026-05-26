# Packaging & dimensions state

**Last updated:** 2026-05-27 (`packaging-wave2-closeout` `20260527T200000Z`)  
**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`

## Wave status summary

| Cohort | Count | Staging | Original |
|--------|------:|---------|----------|
| **Pilot** | 191 | **PASS** active/current | **PASS** (PC05C `20260526T180000Z`) |
| **Wave 1** | 50 | **PASS** execute + active | **PASS** (PC05E `20260526T200000Z`) |
| **Wave 2** | 200 | **PASS** review + activate | **PASS** (PC05F verify `20260526T212000Z`) |

## `dimensions_current` totals

| Ref | Count | Composition |
|-----|------:|-------------|
| Staging | **441** | 191 pilot + 50 Wave1 + 200 Wave2 |
| Original | **441** | same governed cohort (PC05F verify **200/200** matched) |

## Pilot (191)

| Surface | profiles | versions | `dimensions_current` |
|---------|----------|----------|----------------------|
| Staging | 191 active | 191 | 191 |
| Original | 191 | 191 | 191 |

## Wave 1 (50)

| Step | Run | Result |
|------|-----|--------|
| Staging execute | `pc05d-wave1-packaging-scale-staging-execute/20260526T190000Z` | 50 profiles + 50 versions |
| Staging activate | `pc05d-wave1-activate-staging/20260526T193000Z` | active/current |
| Original parity | `pc05e-wave1-original-parity-execute/20260526T200000Z` | 50 profiles + 50 versions |

## Wave 2 (200)

| Step | Run | Result |
|------|-----|--------|
| Staging execute | `pc05d-wave2-packaging-scale-staging-execute/20260526T202000Z` | 200 profiles + 200 versions |
| Staging review | `pc05d-wave2-review-census-staging/20260526T203000Z` | 200 reviewed; 200 eligible; 0 holdout |
| Staging activate | `pc05d-wave2-activate-staging/20260526T204000Z` | 200 activated; 241 → **441** `dimensions_current` |
| Original plan | `pc05f-wave2-original-parity-plan/20260526T210000Z` | missing 200; conflicts 0; unsafe 0 |
| Original execute | `pc05f-wave2-original-parity-execute/20260526T211000Z` | 200 inserted (idempotent OK) |
| Original verify | `pc05f-wave2-original-verify/20260526T212000Z` | **200/200** matched; original **441** `dimensions_current` |

**Data parity:** **CONFIRMED** staging + original for all three cohorts.

## Scale backlog

| Metric | Value |
|--------|------:|
| PC05D scale pool (plan) | 17,805 |
| Waves 1+2 executed | 250 |
| **Manual-review queue remaining** | **17,555** |

## Schema (PC04)

Four tables + refresh + RLS — **IN PARITY** both refs (PC04A `20260523T030000Z`, PC04B `20260523T213909Z`).

## Constraints

No `products` UPDATE · no Amazon API · no AI/OpenAI · no bulk 17k copy to original.

## Evidence

`pc05c-packaging-original-data-parity-execute/20260526T180000Z/` · `pc05d-wave1-packaging-scale-staging-execute/20260526T190000Z/` · `pc05e-wave1-original-parity-execute/20260526T200000Z/` · `pc05d-wave2-review-census-staging/20260526T203000Z/` · `pc05d-wave2-activate-staging/20260526T204000Z/` · `pc05f-wave2-original-parity-plan/20260526T210000Z/` · `pc05f-wave2-original-parity-execute/20260526T211000Z/` · `pc05f-wave2-original-verify/20260526T212000Z/`
