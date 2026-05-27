/**
 * Unit system Phase 1 — code-only implementation plan (no DB, no lib write).
 *
 *   npx tsx scripts/unit-system-phase1-code-plan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT_BASE = ".cursor/audit-reports/unit-system-phase1-code-plan";
const GOVERNANCE_RUN = "20260527T230000Z";

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

  const unitLibraryDesign = `# Unit library design — \`lib/units.ts\`

**Phase:** 1 code-only · **no DB** · **no storage unit migration**  
**Governance:** \`.cursor/audit-reports/unit-system-governance-plan/${GOVERNANCE_RUN}/\`

## Module layout

| File | Role |
|------|------|
| \`lib/units.ts\` | Public API — pure functions, no I/O |
| \`lib/units-types.ts\` | (optional) \`DimensionUnit\`, \`WeightUnit\`, branded tuples |
| \`scripts/test-units.ts\` | Executable fixture tests (repo pattern: \`tsx scripts/test-*.ts\`) |

Prefer **single** \`lib/units.ts\` unless types file exceeds ~120 lines.

## Types

\`\`\`typescript
export type DimensionUnit = "in" | "cm" | "mm";
export type WeightUnit = "lb" | "oz" | "kg" | "g";

export type Measure<TUnit extends string> = {
  value: number;
  unit: TUnit;
};

export type Lwh = {
  length: Measure<DimensionUnit>;
  width: Measure<DimensionUnit>;
  height: Measure<DimensionUnit>;
};

export type PackagingCompareResult = {
  maxAxisDeltaIn: number;
  sameWithinEpsilon: boolean;
  conflictGtThreshold: boolean;
};
\`\`\`

## Constants (exact)

\`\`\`typescript
export const CANONICAL_DIMENSION_UNIT = "in" as const;
export const CANONICAL_WEIGHT_UNIT = "lb" as const;
export const STORAGE_ROUND_DECIMALS = 4;
export const DISPLAY_ROUND_DECIMALS = 2;
export const COMPARE_EPSILON_IN = 0.0001;
export const CONFLICT_THRESHOLD_IN = 1.0;
export const PARITY_SAME_UNIT_EPSILON = 0.0001;
\`\`\`

## API surface

### 1. Parse / normalize aliases

| Function | Input | Output |
|----------|-------|--------|
| \`normalizeDimensionUnit(raw)\` | \`string \\| null\` | \`DimensionUnit \\| null\` |
| \`normalizeWeightUnit(raw)\` | \`string \\| null\` | \`WeightUnit \\| null\` |

Alias map examples:

- Length: \`inch\`, \`inches\`, \`"\`, \`IN\` → \`in\`; \`centimeter\`, \`centimeters\` → \`cm\`; \`millimeter\` → \`mm\`
- Weight: \`pound\`, \`pounds\`, \`lbs\` → \`lb\`; \`ounce\`, \`ounces\` → \`oz\`; \`kilogram\` → \`kg\`; \`gram\`, \`grams\` → \`g\`

Return \`null\` for unknown — caller sets \`needs_review\` in evidence.

### 2. Convert

| Function | Behavior |
|----------|----------|
| \`toCanonicalInches(value, unit)\` | → number in inches |
| \`toCanonicalPounds(value, unit)\` | → number in lb |
| \`fromCanonicalInches(inches, targetUnit)\` | display path |
| \`fromCanonicalPounds(lb, targetUnit)\` | display path |

Internal: \`LENGTH_TO_IN_FACTOR\`, \`WEIGHT_TO_LB_FACTOR\` records keyed by enum.

### 3. Round

| Function | Behavior |
|----------|----------|
| \`roundStorage(n)\` | round half away from zero, 4 dp |
| \`roundDisplay(n, unit)\` | 2 dp for in/cm/lb/kg; 1 dp for mm/oz/g |

### 4. Compare (canonical)

| Function | Behavior |
|----------|----------|
| \`maxAxisDeltaInches(sheetIn, dbL, dbW, dbH, dbUnit)\` | max abs Δ on L/W/H after db → in |
| \`dimsSameCanonical(sheetIn, db..., epsilon?)\` | all axes < ε (default \`COMPARE_EPSILON_IN\`) |
| \`dimsConflictCanonical(..., threshold?)\` | any axis > threshold (default \`CONFLICT_THRESHOLD_IN\`) |
| \`compareLwhCanonical(a, b)\` | both sides may be different storage units |

**Sheet spreadsheet rows:** when source is already parsed as inches, pass \`unit='in'\` explicitly.

### 5. Parse dimension strings (consolidate)

| Function | Behavior |
|----------|----------|
| \`parseLwhString(raw: string)\` | Returns \`Lwh \\| null\` — port logic from Python + PC05 dry-run |

Rules (preserve current behavior):

- Split on \`x\` / \`×\` (case insensitive)
- Extract first number per segment
- Unit from string: \`CM\` → cm, else default **in** for US spreadsheet
- Require 3 positive finite numbers

### 6. Storage tuple helpers (no conversion on write v1)

| Function | Behavior |
|----------|----------|
| \`assertStorageTuple(l, w, h, dimUnit)\` | throws if unit null when values set |
| \`formatMeasureDisplay(m)\` | \`"12.50 in"\` for UI later |

### 7. Display preferences (stub for Phase 2)

| Function | Behavior |
|----------|----------|
| \`resolveDisplayUnits(prefs?)\` | returns \`{ dimension: 'in', weight: 'lb' }\` until org columns exist |

## Non-goals (Phase 1)

- No \`organization_settings\` reads
- No mass conversion of existing DB rows
- No Python port required in Phase 1 (TS consumers first)
`;

  const integrationPoints = `# Integration points

## Phase 1 — wire now (behavior-preserving refactors)

| Priority | File | Change |
|----------|------|--------|
| P0 | \`lib/units.ts\` | **Create** — new module |
| P0 | \`scripts/test-units.ts\` | **Create** — fixtures + \`package.json\` script \`test:units\` |
| P1 | \`scripts/spreadsheet-staging-match-census.ts\` | Replace inline \`toInches\`, \`dimsSame\`, \`maxAxisDeltaIn\` with \`lib/units\` |
| P1 | \`scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts\` | \`parseMeasure\`: \`normalizeDimensionUnit\` / \`normalizeWeightUnit\` on Amazon unit strings; optional canonical compare in \`dimsConflict\` |
| P2 | \`scripts/pc05-product-packaging-governed-backfill-dry-run.ts\` | Replace \`parseDimensions()\` body with \`parseLwhString\` + storage rounding |
| P2 | \`scripts/spreadsheet-governed-import-plan.ts\` | No logic change; future execute reads plan JSON |
| P3 | \`scripts/product-dimensions-spreadsheet-intake-audit.ts\` | Keep Python loader; document duplicate until Phase 1b |

## Phase 1b — Python alignment (optional)

| File | Change |
|------|--------|
| \`scripts/product-dimensions-spreadsheet-intake-analyze.py\` | Call TS via subprocess OR duplicate factors with comment linking to \`lib/units.ts\` |
| \`scripts/spreadsheet-staging-match-census-load.py\` | Same |
| \`scripts/product-dimensions-spreadsheet-canonical-mapping-analyze.py\` | Same |

Recommendation: **defer Python** until spreadsheet execute is TS-only; avoids dual maintenance.

## Phase 2 — later (out of Phase 1 scope)

| Area | Integration |
|------|-------------|
| \`scripts/spreadsheet-packaging-import-staging-execute.ts\` | **Create** when approved; use \`roundStorage\`, enum normalization on insert plan |
| PC05 review census scripts | \`dimsMatch\` stays same-unit for parity; add \`dimsSameCanonical\` only in spreadsheet/SP-API reconciliation reports |
| PIM / API routes | \`storage\` + \`display\` DTO using \`fromCanonical*\` + \`resolveDisplayUnits\` |
| \`app/settings/*\` | Org display unit pickers (needs DDL Phase 2 governance) |

## Import graph (target)

\`\`\`text
lib/units.ts
  ↑ scripts/spreadsheet-staging-match-census.ts
  ↑ scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts
  ↑ scripts/pc05-product-packaging-governed-backfill-dry-run.ts
  ↑ (future) scripts/spreadsheet-packaging-import-staging-execute.ts
  ↑ (future) app/** packaging display formatters
\`\`\`

No imports from \`lib/units\` into browser client bundles until display Phase 2 — keep server/scripts only initially.
`;

  const parserImpact = `# Parser impact report

## Current duplication (inspected)

| Location | Language | Unit logic | Risk if changed |
|----------|----------|------------|-----------------|
| \`scripts/spreadsheet-staging-match-census.ts\` | TS | Inline \`toInches\` (in/cm/mm), ε=0.0001, conflict 1.0 in | **Low** — refactor to lib |
| \`scripts/spreadsheet-staging-match-census-load.py\` | Python | \`parse_dims\`, inch default | **None** in Phase 1 if untouched |
| \`scripts/product-dimensions-spreadsheet-intake-analyze.py\` | Python | Same as load.py | **None** if untouched |
| \`scripts/product-dimensions-spreadsheet-canonical-mapping-analyze.py\` | Python | Same | **None** if untouched |
| \`scripts/pc05-product-packaging-governed-backfill-dry-run.ts\` | TS | \`parseDimensions\`: JSON + regex; cm/in only | **Low** |
| \`scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts\` | TS | \`parseMeasure\` passes raw Amazon unit string; \`dimsConflict\` uses **15% relative** not inches | **Medium** — document before changing conflict function |
| \`scripts/pc05*-verify-census.ts\` (×6) | TS | \`dimsMatch\`: same stored unit + ε 0.0001 | **Do not change** in Phase 1 |
| \`scripts/spreadsheet-governed-import-plan.ts\` | TS | Hardcodes \`in\`/\`lb\` on insert plan | **None** |

## SP-API specific gap

Amazon catalog \`{ value, unit }\` may return \`inches\`, \`pounds\`, etc. Today:

- Units pass through **unvalidated** on \`ParsedDims.unit\`
- \`dimsConflict\` compares raw numbers (assumes same unit)

**Phase 1 fix:** normalize units at parse boundary; add **optional** \`dimsConflictCanonical\` alongside existing 15% check (keep both; report which fired).

## Spreadsheet specific

- Python parsers default to **in** unless \`CM\` in string
- Census TS compares sheet numbers as inches vs DB with conversion — **correct**
- Import plan hardcodes \`dimension_unit: "in"\` — aligned with sheet audit

## Parity scripts (frozen)

\`pc05-packaging-full-parity-verify.ts\` and wave verify scripts compare \`dimension_unit\` string equality — **must not** convert stored values in Phase 1.

## Expected diff size (estimate)

| File | LOC Δ |
|------|------:|
| \`lib/units.ts\` | +180–250 new |
| \`scripts/test-units.ts\` | +120–180 new |
| \`spreadsheet-staging-match-census.ts\` | −25 / +10 |
| \`sp-api-packaging-dimensions-evidence-dry-run-execute.ts\` | +30–50 |
| \`pc05-product-packaging-governed-backfill-dry-run.ts\` | −20 / +5 |

**Total:** ~350–450 LOC, no schema migrations.
`;

  const testPlan = `# Test plan — Phase 1

## Runner

Add to \`package.json\`:

\`\`\`json
"test:units": "tsx scripts/test-units.ts"
\`\`\`

Pattern: self-contained \`scripts/test-units.ts\` with assertions (like \`test-claim-evidence-preview.ts\`), exit code 1 on failure.

## Fixture categories

### normalizeDimensionUnit / normalizeWeightUnit

- \`IN\`, \`inch\`, \`"\` → \`in\`
- \`centimeters\` → \`cm\`
- \`lbs\`, \`pounds\` → \`lb\`
- garbage → \`null\`

### Conversion reversibility

- 10 in → cm → in within ε
- 1 lb → kg → lb within ε

### roundStorage / roundDisplay

- 1.23456789 → 1.2346 storage
- Display 31.75 cm from 12.5 in

### compareLwhCanonical

- Same tuple in cm vs in → \`sameWithinEpsilon: true\`
- 2.0 in vs 3.5 in → \`conflictGtThreshold: true\` at 1.0 in threshold
- Boundary: 1.01 in delta → conflict; 0.99 → not

### parseLwhString

- \`11" x 5.5 x 7.5"\` → in, 11, 5.5, 7.5
- \`12 IN L x 6.25 IN W x 4.5 IN H\` → in
- \`10 x 20 x 30 cm\` → cm
- empty → null

### Regression guard

- Export \`PARITY_SAME_UNIT_EPSILON = 0.0001\` — document match with \`dimsMatch\` in verify scripts

## CI

- Run \`npm run test:units\` in local preflight before spreadsheet/SP-API script changes
- No staging DB required

## Out of scope

- Browser/component tests
- Golden-file SP-API catalog JSON (optional Phase 1b)
`;

  const blockers = `# Blockers

## Plan phase (this run)

None — documentation only.

## Implementation phase (next)

| Blocker | Mitigation |
|---------|------------|
| SP-API \`dimsConflict\` behavior change | Keep legacy 15% fn; add canonical fn; compare counts in dry-run diff |
| Python duplicate parsers | Defer Phase 1b or accept drift with cross-link comment |
| No \`lib/units\` in client yet | Enforce import only from \`scripts/**\` and server modules via lint rule (optional) |

## Explicit non-blockers

- Approval flags for spreadsheet import (separate wave)
- Org display unit DDL (Phase 2)
- Governed packaging row unit migration (Phase 4 governance)
`;

  const filesCreate = [
    "lib/units.ts",
    "scripts/test-units.ts",
  ];
  const filesChange = [
    "package.json",
    "scripts/spreadsheet-staging-match-census.ts",
    "scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts",
    "scripts/pc05-product-packaging-governed-backfill-dry-run.ts",
  ];
  const filesDefer = [
    "scripts/product-dimensions-spreadsheet-intake-analyze.py",
    "scripts/spreadsheet-staging-match-census-load.py",
    "scripts/product-dimensions-spreadsheet-canonical-mapping-analyze.py",
    "pc05-*-verify-census.ts (parity — frozen)",
  ];

  fs.writeFileSync(path.join(outDir, "unit-library-design.md"), unitLibraryDesign);
  fs.writeFileSync(path.join(outDir, "integration-points.md"), integrationPoints);
  fs.writeFileSync(path.join(outDir, "parser-impact-report.md"), parserImpact);
  fs.writeFileSync(path.join(outDir, "test-plan.md"), testPlan);
  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "UNIT SYSTEM PHASE 1 — CODE-ONLY IMPLEMENTATION PLAN",
        run_id: runId,
        read_only: true,
        no_db_writes: true,
        governance_plan: `unit-system-governance-plan/${GOVERNANCE_RUN}`,
        risk_level: "low",
        risk_notes: "medium only if SP-API dimsConflict is replaced without dual-run",
        files_create: filesCreate,
        files_change: filesChange,
        files_defer: filesDefer,
        next_prompt:
          "UNIT SYSTEM PHASE 1 IMPLEMENT — create lib/units.ts + scripts/test-units.ts (npm run test:units); refactor spreadsheet-staging-match-census.ts and sp-api-packaging-dimensions-evidence-dry-run-execute.ts to use lib; no DB DDL",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        risk_level: "low",
        files_create: filesCreate,
        files_change: filesChange,
        next_prompt:
          "UNIT SYSTEM PHASE 1 IMPLEMENT — create lib/units.ts + scripts/test-units.ts (npm run test:units); refactor spreadsheet-staging-match-census.ts and sp-api-packaging-dimensions-evidence-dry-run-execute.ts to use lib; no DB DDL",
      },
      null,
      2,
    ),
  );
}

main();
