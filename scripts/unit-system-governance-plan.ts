/**
 * Unit system governance plan (read-only) — writes audit artifacts.
 *
 *   npx tsx scripts/unit-system-governance-plan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT_BASE = ".cursor/audit-reports/unit-system-governance-plan";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const canonicalUnitSystem = `# Canonical unit system

**Mode:** read-only governance plan · **no DB mutations**  
**Run:** \`${OUT_BASE}/${runId}/\`  
**Schema authority:** PC04 \`product_packaging_profile_versions\` / \`product_packaging_dimensions_current\`

## Supported units (closed enums)

| Family | Code | Label | Storage allowed | Display allowed |
|--------|------|-------|:-------------:|:---------------:|
| Length | \`in\` | inch | ✓ | ✓ |
| Length | \`cm\` | centimeter | ✓ | ✓ |
| Length | \`mm\` | millimeter | ✓ | ✓ |
| Mass | \`lb\` | pound | ✓ | ✓ |
| Mass | \`oz\` | ounce | ✓ | ✓ |
| Mass | \`kg\` | kilogram | ✓ | ✓ |
| Mass | \`g\` | gram | ✓ | ✓ |

No other unit strings may be persisted on packaging version rows (DB CHECK). UI and APIs must map aliases (\`inch\`, \`lbs\`, \`IN\`) at the boundary.

## Three-layer model

\`\`\`text
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 — Storage tuple (authoritative per version row)     │
│  length_value, width_value, height_value + dimension_unit    │
│  weight_value + weight_unit                                  │
│  Written at ingest; never unitless                           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Layer 2 — Logical canonical (compare / claims / cube math)  │
│  Dimensions → inches (in)                                    │
│  Mass → pounds (lb)                                          │
│  Computed in application code; not a second DB column (v1)   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Layer 3 — Display tuple (UI / API response formatting)      │
│  Resolved from preference chain → convert from Layer 1       │
│  Shown with unit suffix; optional secondary readout            │
└─────────────────────────────────────────────────────────────┘
\`\`\`

### Layer 1 — Storage (per version)

- **Rule:** Values are stored in the **unit declared at ingest** for that version (\`dimension_unit\`, \`weight_unit\`).
- **Precision:** \`numeric(12, 4)\` — four decimal places max in Postgres.
- **Why not normalize everything to inches on write (v1):** Governed parity scripts (\`dimsMatch\`) compare stored unit strings exactly; mass rewrites would invalidate **491/491** staging/original parity without an approved migration.

### Layer 2 — Logical canonical (comparison)

| Quantity | Canonical unit | Use |
|----------|----------------|-----|
| Length / width / height | **\`in\`** | Cross-source diff (spreadsheet vs SP-API), volume reconciliation, claims thresholds |
| Mass | **\`lb\`** | Weight limits, freight estimates |

Canonical conversion is **derived at read/compare time**, not stored on the row (until a future optional migration adds \`length_value_canonical_in\` etc.).

### Layer 3 — Display

| Quantity | Default display (US Amazon tenant) | Metric alternative |
|----------|--------------------------------------|--------------------|
| Dimensions | \`in\` | \`cm\` |
| Mass | \`lb\` | \`kg\` |

Display does **not** change stored facts.

## Preference resolution

Precedence (highest wins for UI default and API \`display_*\` fields):

\`\`\`text
1. Operator preference (per user profile)
2. Store preference (per stores row / store-scoped JSON)
3. Organization preference (organization_settings)
4. Platform default (US marketplace tenant → in + lb)
\`\`\`

| Scope | Proposed location | Keys |
|-------|-------------------|------|
| **Operator** | \`profiles.preferences\` jsonb (new) or auth user metadata | \`packaging.display_dimension_unit\`, \`packaging.display_weight_unit\` |
| **Store** | \`stores.metadata\` jsonb or \`module_configs\` on org | \`packaging.display_dimension_unit\`, \`packaging.display_weight_unit\` |
| **Org** | \`organization_settings\` columns (mirror \`display_currency_code\`) | \`display_dimension_unit\`, \`display_weight_unit\` |
| **Platform** | constant in \`lib/units\` | \`in\`, \`lb\` |

**Independence:** Dimension display unit and weight display unit are chosen separately (operator may prefer cm + lb).

**Ingest default (no preference):** When source does not specify unit (rare), use org → store → platform:

- Amazon US catalog / operator spreadsheet → **\`in\`** / **\`lb\`**
- Explicit \`cm\` in source string → store as **\`cm\`** (do not auto-downgrade to inches on write)

## Relationship to existing patterns

| Pattern | Precedent |
|---------|-----------|
| Org display currency | \`organization_settings.display_currency_code\` (ISO 4217) |
| Module config without DDL | \`workspace_settings.module_configs\` JSONB |
| Packaging facts | PC04 enums on version rows |
| Parity tolerance | \`Math.abs(a - b) < 0.0001\` same unit (\`pc05*-verify-census.ts\`) |
| Cross-source conflict | > **1.0 in** on any axis after canonical conversion (spreadsheet mapping plan) |

## Non-goals (this plan)

- Changing CHECK enums or \`numeric\` precision without migration approval
- Mass-converting existing **491** governed \`dimensions_current\` rows
- Storing unitless L×W×H in \`products\` legacy columns for new packaging work
`;

  const conversionRules = `# Conversion rules

All factors are **exact** definitions; implementations must use these constants (recommend shared \`lib/units.ts\`).

## Length → canonical inch (\`in\`)

| From | Multiply value by |
|------|-------------------:|
| \`in\` | 1 |
| \`cm\` | 0.3937007874 (= 1 / 2.54) |
| \`mm\` | 0.03937007874 (= 1 / 25.4) |

\`\`\`text
length_in = length_value * factor(dimension_unit → in)
\`\`\`

## Length from inch (display)

| To | Multiply \`length_in\` by |
|----|------------------------:|
| \`in\` | 1 |
| \`cm\` | 2.54 |
| \`mm\` | 25.4 |

## Mass → canonical pound (\`lb\`)

| From | Multiply value by |
|------|-------------------:|
| \`lb\` | 1 |
| \`oz\` | 0.0625 (= 1 / 16) |
| \`kg\` | 2.2046226218 |
| \`g\` | 0.0022046226218 |

\`\`\`text
weight_lb = weight_value * factor(weight_unit → lb)
\`\`\`

## Mass from pound (display)

| To | Multiply \`weight_lb\` by |
|----|--------------------------:|
| \`lb\` | 1 |
| \`oz\` | 16 |
| \`kg\` | 0.45359237 |
| \`g\` | 453.59237 |

## When to convert

| Stage | Action |
|-------|--------|
| **Ingest** | Parse source unit → normalize alias → **persist original unit** on version row |
| **Compare / conflict** | Convert both sides to canonical \`in\` / \`lb\` → apply thresholds |
| **Display** | Convert storage tuple → operator/org display unit for UI only |
| **Activate / parity verify** | Compare **stored** unit + value (same as today); optional canonical check in review census |
| **Export / API read** | Return \`storage\` + \`display\` objects |

**Forbidden:** Silent overwrite of storage unit on read paths.

## Source-specific ingest notes

| Source | Typical unit | Ingest rule |
|--------|--------------|-------------|
| Operator spreadsheet | \`in\`, \`lb\` | Quotes / \`IN\` / \`L×W×H\` → \`in\`; header \`LB\` → \`lb\` |
| SP-API Catalog | Often inches in \`value\` + \`unit\` object | Map Amazon strings → enum; if unit missing, default **\`in\`** with \`needs_review\` flag in evidence |
| PC05 backfill dry-run | \`in\` / \`cm\` from string | \`/cm/i\` → \`cm\`, else \`in\` |
| Warehouse measurement | Operator selects unit at entry | Persist selected enum |

## Comparison tolerances (after canonical conversion)

| Check | Rule |
|-------|------|
| Same-unit parity (staging vs original) | \`|a - b| < 0.0001\` on each numeric field; units string-equal |
| Cross-unit “match” | Convert to \`in\` / \`lb\`, then \`|Δ| < 0.01\` in or \`|Δ| < 0.01\` lb |
| Conflict (spreadsheet / SP-API policy) | Any axis \`|Δ| > 1.0\` in after canonical → **conflict** |
| Cube volume reconcile | Compute cu in from L×W×H in inches; compare to volume-only metadata separately |

## Rounding on conversion

See \`canonical-unit-system.md\` rounding section — apply **round half away from zero** at the precision of the target layer.
`;

  const dbStorageRules = `# Database storage rules

## Authoritative tables

| Table | Unit columns | Values |
|-------|--------------|--------|
| \`product_packaging_profile_versions\` | \`dimension_unit\`, \`weight_unit\` | \`length_value\`, \`width_value\`, \`height_value\`, \`weight_value\` |
| \`product_packaging_dimensions_current\` | copied from active version | snapshot for UI / claims |
| \`product_packaging_evidence\` | \`metadata.original_unit\`, raw strings | audit trail |

## Constraints (current / PC04)

\`\`\`sql
dimension_unit IN ('in', 'cm', 'mm')  -- or NULL if no dimensions
weight_unit IN ('lb', 'oz', 'kg', 'g')  -- or NULL if no weight
\`\`\`

- **NULL unit policy:** If any of L/W/H is non-null, \`dimension_unit\` must be non-null. Same for \`weight_value\` / \`weight_unit\`.
- **NULL values:** All three dimensions may be null for structure-only profiles (PC05 waves); unit should be null.

## Write path rules

1. **Never** insert unitless positive dimensions.
2. **Always** set \`dimension_unit\` and \`weight_unit\` from normalized enum (not free text).
3. **Evidence:** \`product_packaging_evidence.metadata\` must include:
   - \`original_raw_dimensions\`, \`original_raw_weight\`
   - \`normalized_unit\`, \`normalization_run_id\`
4. **source_type** does not imply unit — unit comes from parsed payload.
5. **Trigger:** \`refresh_product_packaging_dimensions_current\` copies units verbatim to snapshot.

## Precision and rounding at persistence

| Field | Postgres type | Round before INSERT |
|-------|---------------|---------------------|
| L, W, H | \`numeric(12,4)\` | 4 decimal places |
| Weight | \`numeric(12,4)\` | 4 decimal places |

\`\`\`text
roundStorage(x) = round(x, 4)
\`\`\`

If ingest converts cm → in for storage in a **future** normalized-storage migration, apply \`roundStorage\` **once** after conversion.

## Indexing / query

- Filters and joins use **stored** tuple, not display unit.
- Claims / scanner read \`product_packaging_dimensions_current\` — no runtime conversion in SQL (v1).

## Legacy \`products\` columns

- Legacy Amazon cache fields on \`products\` remain **out of scope** for new packaging writes.
- Backfill mapping (PC05) targets packaging tables only.
- Do not assume legacy units match packaging enums without census.

## Parity and staging/original sync

- Replication scripts (\`pc05f\`, \`pc05g\`) copy \`dimension_unit\` and \`weight_unit\` **as-is**.
- Changing storage unit on one side without the other fails \`dimsMatch\`.

## Proposed optional columns (future migration — not applied)

| Column | Purpose |
|--------|---------|
| \`organization_settings.display_dimension_unit\` | org default display |
| \`organization_settings.display_weight_unit\` | org default display |
| \`length_value_canonical_in\` etc. | denormalized canonical (only if compare-at-scale requires) |

**v1 recommendation:** omit canonical columns; use \`lib/units\` at application layer.
`;

  const uiDisplayRules = `# UI and API display rules

## API response shape (recommended)

\`\`\`json
{
  "packaging": {
    "storage": {
      "length": { "value": 12.5, "unit": "in" },
      "width":  { "value": 6.25, "unit": "in" },
      "height": { "value": 4.5,  "unit": "in" },
      "weight": { "value": 3.2,  "unit": "lb" }
    },
    "display": {
      "length": { "value": 31.75, "unit": "cm" },
      "width":  { "value": 15.88, "unit": "cm" },
      "height": { "value": 11.43, "unit": "cm" },
      "weight": { "value": 1.45,  "unit": "kg" }
    },
    "display_preferences": {
      "dimension_unit": "cm",
      "weight_unit": "kg",
      "resolved_from": "operator"
    }
  }
}
\`\`\`

- **Storage** = DB truth from \`dimensions_current\`.
- **Display** = converted using resolved preference chain.
- **Claims and filing PDFs** use **storage** unless org policy explicitly requests display (document in template).

## API write shape (recommended)

\`\`\`json
{
  "length": { "value": 31.75, "unit": "cm" },
  "width":  { "value": 15.88, "unit": "cm" },
  "height": { "value": 11.43, "unit": "cm" },
  "weight": { "value": 1.45, "unit": "kg" }
}
\`\`\`

Server actions must:

1. Validate unit ∈ allowed enum.
2. Convert to storage policy (v1: **keep submitted unit**, \`roundStorage\` on values).
3. Reject if converted canonical dims violate business rules (negative, zero volume).

## UI formatting

| Context | Behavior |
|---------|----------|
| **PIM product / packaging panel** | Show \`display\` tuple; footnote “Stored: 12.5 × 6.25 × 4.5 in” when display ≠ storage |
| **Edit form** | Inputs in user's display unit; live preview of storage unit |
| **Imports preview** | Show parsed storage + warning if source unit ambiguous |
| **Scanner / warehouse** | Default to operator preference; allow per-session toggle (cm/in) |
| **Review census (PC05)** | Always show **storage** tuple for parity sign-off |
| **Settings → General** | Add unit pickers next to currency (org default) |
| **Settings → Store** | Optional store override |

### Format strings

| Unit | Example format |
|------|----------------|
| \`in\` | \`12.50 in\` or \`12.5"\` (use consistent symbol in PIM) |
| \`cm\` | \`31.8 cm\` |
| \`mm\` | \`318 mm\` (often 0 decimals) |
| \`lb\` | \`3.20 lb\` |
| \`oz\` | \`51.2 oz\` |
| \`kg\` | \`1.45 kg\` |
| \`g\` | \`1450 g\` |

**Decimal places (display):**

| Unit | Min | Max |
|------|-----|-----|
| \`in\`, \`cm\`, \`lb\`, \`kg\` | 0 | 2 |
| \`mm\` | 0 | 1 |
| \`oz\`, \`g\` | 0 | 1 (or integer for g > 100) |

## Rounding (display layer)

\`\`\`text
roundDisplay(x, unit) =
  in, cm, lb, kg → round(x, 2)
  mm            → round(x, 1)
  oz, g         → round(x, 1)  // or integer g when value >= 100
\`\`\`

Do not round before persistence except \`roundStorage(4)\`.

## Error and ambiguity UX

| Condition | UI |
|-----------|-----|
| Missing unit in import | Block save; show “select unit” |
| cm detected in US sheet | Suggest confirm; tag \`needs_review\` |
| Display ≠ storage | Informational badge, not error |
| Cross-unit conflict > 1 in | Conflict panel with both tuples in canonical in |

## Security / contract

- Browser must not write packaging tables directly (product resolution contract).
- Unit conversion runs **server-side** only.
- API list endpoints may accept \`?display_unit=cm\` for convenience — must not mutate DB.
`;

  const migrationImpact = `# Migration impact report

**Status:** plan only · **no migrations executed**

## Current state (observed)

| Area | State |
|------|--------|
| Packaging schema | PC04 enums: \`in|cm|mm\`, \`lb|oz|kg|g\` on version + current tables |
| Governed data | **491** \`dimensions_current\` rows (staging + original parity **441/441** PASS — note memory may say 491 post-W3) |
| Parity scripts | Exact match on \`dimension_unit\` / \`weight_unit\` strings + numeric ε = 0.0001 |
| Org settings | \`display_currency_code\` exists; **no** display unit columns yet |
| Shared conversion lib | **Absent** — logic duplicated in backfill dry-run + spreadsheet parser |
| UI packaging module | Minimal; reads mostly via governed scripts / future PIM panel |

## Impact matrix

| Change | DB migration | Data backfill | Parity risk | UI work |
|--------|:------------:|:-------------:|:---------:|:-------:|
| Add \`lib/units.ts\` (pure functions) | None | None | None | Wire APIs |
| Org \`display_*_unit\` columns | Low (nullable + default) | None | None | Settings page |
| Store metadata unit prefs | None if JSONB | None | None | Store admin |
| Operator profile preferences | Low (jsonb column) | None | None | Profile settings |
| Normalize all rows to \`in\`/\`lb\` on disk | **High** | **Required** | **Breaks** verify unless paired staging+original | Low |
| Add \`_*_canonical_*\` columns | Medium | Backfill optional | Low if nullable | Low |
| Tighten CHECK (remove \`mm\`) | **Breaking** | — | **High** | — |

## Recommended rollout phases

### Phase 0 — This plan (complete)

Documentation + shared conversion module spec.

### Phase 1 — Code-only (no DDL)

- Implement \`lib/units.ts\` with factors, \`toCanonical\`, \`toDisplay\`, \`roundStorage\`, \`roundDisplay\`.
- Use in spreadsheet intake, SP-API evidence parser, review census **read paths** only.
- **Zero** change to stored rows.

### Phase 2 — Preferences DDL (nullable)

\`\`\`sql
ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS display_dimension_unit text NOT NULL DEFAULT 'in',
  ADD COLUMN IF NOT EXISTS display_weight_unit text NOT NULL DEFAULT 'lb';
-- CHECK constraints matching enums
\`\`\`

- Defaults preserve US behavior.
- No change to packaging version rows.

### Phase 3 — UI / API

- Settings pickers; API dual \`storage\` / \`display\` objects.
- Operator preference in \`profiles\` jsonb (separate small migration).

### Phase 4 — Optional storage normalization (approval-gated)

Only if analytics require single-unit SQL:

1. Census all distinct \`dimension_unit\` / \`weight_unit\` counts on **491** cohort.
2. If 100% already \`in\`/\`lb\`, skip conversion.
3. Else governed migration: new version rows (not UPDATE in place), \`needs_review\` → census → activate.
4. Re-run \`pc05-packaging-full-parity-verify\` on staging + original.

## Safety rules (non-negotiable)

1. **No in-place UPDATE** of active version numeric/unit fields without new version + supersede chain.
2. **No parity execute** during unit migration window.
3. **Preserve evidence** raw strings when converting storage unit.
4. **Spreadsheet / SP-API imports** continue to default \`in\`/\`lb\` for US sources but must honor explicit \`cm\`/\`kg\` when present.
5. **Rollback:** new versions can be \`rejected\`; prior version re-activated — do not delete history.

## Verification checklist (post-implementation)

- [ ] \`npm run check:product-resolution-contract-v192\` still passes
- [ ] Parity verify **N/N** unchanged on pilot + waves
- [ ] Unit tests: conversion reversibility within ε (\`in\` → \`cm\` → \`in\`)
- [ ] Unit tests: conflict threshold 1.0 in at boundary (1.01 vs 0.99 in)
- [ ] Settings UI saves org preference without touching packaging tables

## Related artifacts

- \`.cursor/audit-reports/product-dimensions-spreadsheet-intake-audit/20260527T210000Z/\`
- \`.cursor/audit-reports/product-dimensions-spreadsheet-canonical-mapping-plan/20260527T220000Z/\`
- \`.ai-memory/PACKAGING_DIMENSIONS_STATE.md\`
`;

  fs.writeFileSync(path.join(outDir, "canonical-unit-system.md"), canonicalUnitSystem);
  fs.writeFileSync(path.join(outDir, "conversion-rules.md"), conversionRules);
  fs.writeFileSync(path.join(outDir, "db-storage-rules.md"), dbStorageRules);
  fs.writeFileSync(path.join(outDir, "ui-display-rules.md"), uiDisplayRules);
  fs.writeFileSync(path.join(outDir, "migration-impact-report.md"), migrationImpact);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "UNIT SYSTEM GOVERNANCE PLAN",
        run_id: runId,
        read_only: true,
        no_db_writes: true,
        supported_dimension_units: ["in", "cm", "mm"],
        supported_weight_units: ["lb", "oz", "kg", "g"],
        logical_canonical: { dimension: "in", weight: "lb" },
        platform_default_display: { dimension: "in", weight: "lb" },
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, outDir }, null, 2));
}

main();
