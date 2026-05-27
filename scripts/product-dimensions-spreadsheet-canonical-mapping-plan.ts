/**
 * Product dimensions spreadsheet — canonical mapping plan (read-only).
 *
 *   npx tsx scripts/product-dimensions-spreadsheet-canonical-mapping-plan.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const INTAKE_RUN = "20260527T210000Z";
const INTAKE_BASE = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit";
const OUT_BASE = ".cursor/audit-reports/product-dimensions-spreadsheet-canonical-mapping-plan";
const DEFAULT_XLSX = path.join(INTAKE_BASE, "_tmp", "dims-sheet.xlsx");
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8/edit";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type AnalyzeOut = {
  summary: Record<string, number | string>;
  headers: string[];
  column_keys: Record<string, string | null>;
  queue_sample_review: Array<{
    row: number;
    seller_sku: string;
    asin: string;
    merge_class: string;
    reasons: string[];
  }>;
  queue_sample_importable: Array<{
    row: number;
    seller_sku: string;
    asin: string;
    merge_class: string;
    reasons: string[];
  }>;
  review_required_count: number;
  importable_merge_safe_count: number;
};

async function main(): Promise<void> {
  const runId = runIdArg();
  const xlsxPath = path.resolve(process.cwd(), DEFAULT_XLSX);
  const intakeManifest = path.join(process.cwd(), INTAKE_BASE, INTAKE_RUN, "manifest.json");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Missing xlsx at ${xlsxPath}; run product-dimensions-spreadsheet-intake-audit first.`);
  }

  const pyScript = path.join(
    process.cwd(),
    "scripts",
    "product-dimensions-spreadsheet-canonical-mapping-analyze.py",
  );
  const pyOut = execSync(`python "${pyScript}" "${xlsxPath}" "${INTAKE_RUN}"`, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const data = JSON.parse(pyOut) as AnalyzeOut;
  const s = data.summary;

  const intakeSummary = fs.existsSync(intakeManifest)
    ? (JSON.parse(fs.readFileSync(intakeManifest, "utf8")) as { summary?: Record<string, unknown> }).summary
    : null;

  const canonicalColumnMapping = `# Canonical column mapping

**Spreadsheet:** [Product dimensions sheet](${SHEET_URL})  
**Intake audit:** \`${INTAKE_BASE}/${INTAKE_RUN}/\`  
**Plan run:** \`${OUT_BASE}/${runId}/\`

## Architecture target

\`\`\`text
spreadsheet row
  → normalize identifiers (resolver contract)
  → products.id via seller-sku + store_id (primary join)
  → product_identifier_map validation (ASIN / FNSKU / UPC — evidence only unless governed map prompt)
  → product_packaging_profiles (composite key)
  → product_packaging_profile_versions (facts + source_type)
  → product_packaging_dimensions_current (active snapshot only after activate)
  → product_packaging_evidence (import_row / operator_note)
\`\`\`

**Composite profile key (non-negotiable):**

\`organization_id + store_id + product_id + packaging_level + fulfillment_context\`

## Spreadsheet → canonical identifiers

| Spreadsheet column | Canonical target | Join / write policy |
|--------------------|------------------|------------------------|
| \`seller-sku\` | \`products.sku\` → \`products.id\` (\`product_id\`) | **Primary join key** for packaging import; must match Sam store scope in census |
| \`ASIN (B0)\` | \`products.asin\` + \`product_identifier_map.asin\` | **Validation only** on import; mismatch → \`review-required\`; no auto map INSERT in packaging wave |
| \`FNSKU (X0)\` | \`products.fnsku\` + map \`fnsku\` | Secondary validation; ${String(s.total_rows)} rows, ~3,273 with FNSKU — absent FNSKU does not block case-dim import |
| \`Unit UPC\` | \`products.upc_code\` / map \`upc\` | Sparse; **merge-safe evidence only** — not primary join |
| \`Case UPC\` | \`product_packaging_evidence.metadata.case_upc\` | Descriptive / evidence; no map upsert |
| \`Mfg #\` | \`products.mfg_part_number\` | Evidence / cross-check only |
| \`Brand\` | \`products.vendor_name\` or evidence | **Overwrite-forbidden** on \`products\` in packaging scope |

## Spreadsheet → packaging tables

Default packaging slice for this sheet (case-level wholesale logistics data):

| Field | \`product_packaging_profiles\` | \`product_packaging_profile_versions\` |
|-------|----------------------------------|----------------------------------------|
| (resolved) \`product_id\` | \`product_id\` | — |
| — | \`packaging_level\` = \`case\` | — |
| \`FBA / FBM\` | \`fulfillment_context\` = \`fba\` \| \`mfn\` \| \`unknown\` | — |
| \`Case Dimensions…\` | — | \`length_value\`, \`width_value\`, \`height_value\`, \`dimension_unit\` = \`in\` |
| \`Case Net / Gross Wt (LB)\` | — | \`weight_value\`, \`weight_unit\` = \`lb\` |
| \`Case Pack\` | — | \`units_per_case\` |
| \`Selling pack ct\` | — | \`units_per_inner_pack\` (if inner ≠ case) |
| \`Ti\` / \`Hi\` | \`notes\` / \`evidence_summary\` | pallet grid hints |
| \`Cases Per Pallet\` | — | \`units_per_pallet\` (cases × case pack semantics — verify at review) |
| \`Description\` | \`display_label\` / evidence | not a dimensional claim |

**\`source_type\`:** \`import\`  
**\`source_reference\`:** \`spreadsheet_intake:${INTAKE_RUN}:row=<n>\`  
**\`profile_status\` (initial):** \`needs_review\` (all rows; PC05 pattern)

## Row-level merge classification (spreadsheet-only)

| Class | Rows | Meaning |
|-------|-----:|---------|
| **merge-safe** | ${s.merge_safe} | Parseable case L×W×H + no ASIN dimension conflict; still requires staging match + no active \`dimensions_current\` collision |
| **review-required** | ${s.review_required} | Missing dimensions, duplicate ASIN/SKU variant rows, or identifier gaps |
| **conflict** | ${s.conflict} | ASIN maps to **multiple distinct** L×W×H tuples in sheet |

Intake cross-check: importable L×W×H **${intakeSummary?.importable_rows_estimate ?? 175}**; merge-safe with dims **${data.importable_merge_safe_count}**.

## Forbidden in packaging import scope

- \`products\` UPDATE / INSERT
- \`product_identifier_map\` INSERT (separate governed map prompt)
- Direct \`dimensions_current\` INSERT (trigger via active version only)
- \`package_items\`
`;

  const mergeStrategy = `# Canonical merge strategy

## Objective

Attach **case-level** dimensional facts from the operator spreadsheet to existing \`product_id\` rows without violating the product resolution contract or clobbering governed **491** active packaging profiles.

## Phase A — Read-only (complete)

- Spreadsheet intake audit (\`${INTAKE_RUN}\`)
- This canonical mapping plan (\`${runId}\`)

## Phase B — Staging match census (read-only SQL)

For each **merge-safe** row (${data.importable_merge_safe_count} spreadsheet rows; ${s.parseable_lwh} with L×W×H):

1. Resolve \`product_id\` = \`products.id\` WHERE \`sku\` = seller-sku AND \`store_id\` = Sam store.
2. If 0 rows → cohort \`product_missing\` (do not create product).
3. If >1 row → cohort \`ambiguous_sku\` → **review-required**.
4. Compare ASIN to \`products.asin\` and active \`product_identifier_map\` → \`identifier_mismatch\` → **review-required**.
5. Check existing \`product_packaging_dimensions_current\` for key \`(product_id, case, fulfillment_context)\`:
   - none → eligible for **new profile** insert
   - \`needs_review\` draft from prior wave → **merge-safe** new version
   - **active** with L×W×H → **review-required** (supersede workflow)
   - active **volume-only** (SP-API / structure) without L×W×H → **merge-safe** new version with reconciliation flag

## Phase C — Governed insert (approval-gated, not this prompt)

- Insert \`product_packaging_profiles\` + \`product_packaging_profile_versions\` with \`profile_status=needs_review\`
- \`source_type=import\`, batch tag \`SPREADSHEET_INTAKE_${runId}\`
- Attach \`product_packaging_evidence\` row \`evidence_type=import_row\` with raw dimension string + row number

## Phase D — Review census → activate

Mirror PC05 Wave 2/3:

- Review census script validates L×W×H, units, store, no unsafe supersede
- Activate promotes version → \`dimensions_current\` via trigger

## Duplicate ASIN rows (${s.duplicate_asin_keys} keys)

Same ASIN on multiple rows reflects **case/pack variants**, not conflicting dimensions (intake: **0** ASIN-level dimension conflicts).

**Strategy:** Build profile key using \`product_id + case + fulfillment_context + units_per_case + selling_pack_ct\` in \`display_label\` or evidence; never collapse rows by ASIN alone.

## SP-API reconciliation

For MFBA \`volume_only_no_lwh\` cohort (~435 SKUs in evidence plan):

- SP-API **valid_dimensions** → compare to spreadsheet; if Δ > 1.0 in on any axis → **conflict** queue
- SP-API **volume_only** → spreadsheet L×W×H **merge-safe** as higher-priority physical evidence (still \`needs_review\`)
- Do not auto-activate spreadsheet over active operator/measured profile

## Cohort routing summary

| Cohort | Action |
|--------|--------|
| merge-safe + product match + no active L×W×H | Insert \`needs_review\` version |
| merge-safe + active L×W×H | Review-required supersede |
| review-required (missing dims) | Hold; optional structure-only profile without L×W×H (separate approval) |
| conflict | Operator resolution before any insert |
`;

  const overwriteRules = `# Overwrite rules

## Global policy

Packaging imports **never** mutate \`products\` or \`product_identifier_map\` in the spreadsheet wave. All writes are confined to \`product_packaging_*\` tables under explicit operator approval.

## Field-level rules

| Target | Spreadsheet source | Classification | Rule |
|--------|-------------------|----------------|------|
| \`products.*\` | any | **forbidden** | No UPDATE/INSERT |
| \`product_identifier_map\` | ASIN/FNSKU/UPC | **forbidden** | Validation read only; map changes require E1B/E2-style approval |
| \`product_packaging_profiles.display_label\` | Description, Brand | **overwrite-safe** | Only on **new** profile insert |
| \`product_packaging_profiles.notes\` | Ti, Hi, FBA/FBM | **overwrite-safe** | Profile create only |
| \`profile_versions.length/width/height\` | Case Dimensions | **review-required** | New version; supersede only after census |
| \`profile_versions.weight_*\` | Case Wt LB | **merge-safe** | May populate when empty on draft; never silently replace active measured weight |
| \`profile_versions.units_per_case\` | Case Pack | **merge-safe** | If existing active differs by >0 → **review-required** |
| \`profile_versions.units_per_inner_pack\` | Selling pack ct | **merge-safe** | Same as above |
| \`profile_versions.units_per_pallet\` | Cases Per Pallet | **review-required** | Confirm case vs unit semantics |
| \`dimensions_current\` | — | **forbidden direct** | Trigger-only on \`profile_status=active\` |
| Active version L×W×H | spreadsheet vs existing | **conflict** if max axis Δ > 1.0 in | Hold activation |
| Active version L×W×H | spreadsheet vs SP-API valid | **conflict** if Δ > 1.0 in | Operator picks winner |
| SP-API volume-only metadata | cubic_volume in evidence | **merge-safe** | Spreadsheet L×W×H adds facts; does not delete volume evidence |

## Status transitions

| From | To | Allowed |
|------|-----|---------|
| (none) | \`needs_review\` | Yes — default insert |
| \`needs_review\` | \`active\` | Yes — after review census |
| \`active\` | superseded + new \`needs_review\` | Yes — governed supersede path only |
| \`active\` | in-place UPDATE of L×W×H | **No** — append version |

## Activation overwrite

When activating a spreadsheet-sourced version:

- **overwrite-safe:** replace \`dimensions_current\` snapshot for that \`profile_id\` only
- **never overwrite** another profile level (e.g. do not touch \`unit\`/\`fba\` pilot profiles from PC05 backfill)
`;

  const evidencePriority = `# Evidence priority rules

Priority applies when **choosing which source may become \`profile_status=active\`** for the same composite profile key. Higher number wins at activation time.

| Priority | Source | \`source_type\` | Notes |
|----------|--------|-----------------|-------|
| 5 (highest) | Operator measured / warehouse ticket | \`warehouse_measurement\` | Future; beats all automated sources |
| 4 | Operator override | \`operator_override\` | Explicit sign-off in UI or approval file |
| 3 | **This spreadsheet** (parseable case L×W×H) | \`import\` | Operator-maintained logistics sheet; beats catalog automation for **case** level |
| 2 | Existing governed packaging (active L×W×H) | \`manual\` / \`import\` / \`amazon_report\` | PC05 waves (491 profiles) — supersede requires review census |
| 1 | SP-API catalog dimensions | \`amazon_catalog_api\` | Evidence dry-run only today; **valid L×W×H** competes with spreadsheet — tie → review |
| 0 (lowest) | SP-API / report **volume-only** | \`amazon_catalog_api\` / \`amazon_report\` | Cubic volume without L×W×H — **cannot block** spreadsheet case dims; reconcile in evidence |

## Decision matrix

| Incumbent active facts | Incoming | Result |
|------------------------|----------|--------|
| none | spreadsheet L×W×H | Allow \`needs_review\` → activate after census |
| volume-only (no L×W×H) | spreadsheet L×W×H | **merge-safe**; spreadsheet wins at activation |
| active L×W×H (import/manual) | spreadsheet L×W×H within 1 in | **merge-safe** supersede optional |
| active L×W×H | spreadsheet differs >1 in any axis | **conflict** — operator measured may be required |
| active L×W×H | SP-API valid L×W×H | **review-required** — compare three-way |
| operator_override active | any automated | **conflict** — do not auto-supersede |

## Evidence artifacts

Each spreadsheet version should store:

- \`evidence_type=import_row\`
- \`metadata.sheet_url\`, \`metadata.row\`, \`metadata.raw_dimensions\`, \`metadata.asin\`, \`metadata.seller_sku\`
- \`payload_sha256\` of normalized L×W×H tuple

SP-API JSON remains in audit cache (\`sp-api-packaging-dimensions-evidence-dry-run-execute/\`) until a governed link step attaches \`evidence_type=api_payload\` to the same version chain.

## Confidence scoring (proposed)

| Source | \`confidence_score\` |
|--------|----------------------:|
| operator measured | 0.95 |
| spreadsheet (this file) | 0.85 |
| PC05 manual structure-only | 0.70 |
| SP-API valid L×W×H | 0.75 |
| SP-API volume-only | 0.40 |
`;

  const reviewQueue = `# Review-required queue

**Total rows:** ${s.total_rows}  
**Review-required + conflict:** ${data.review_required_count}  
**Merge-safe (parseable L×W×H, no sheet conflict):** ${data.importable_merge_safe_count}

## Reason taxonomy

| Reason code | Approx rows | Action |
|-------------|------------:|--------|
| \`missing_case_dimensions\` | ${Number(s.total_rows) - Number(s.parseable_lwh)} | No L×W×H import; optional structure-only path |
| \`duplicate_asin_variant_rows\` | ${s.duplicate_asin_keys} ASIN keys | Disambiguate with case pack + selling pack in profile key |
| \`duplicate_seller_sku\` | intake: 105 keys | Verify single \`product_id\` |
| \`fnsku_absent_or_invalid\` | ~1,206 rows | Non-blocking; validate on activate |
| \`asin_conflicting_dimensions\` | ${s.conflicting_asin_keys} | **Block** until operator resolves |
| \`ready_for_staging_match_census\` | ${data.importable_merge_safe_count} | Next read-only SQL cohort |

## Sample — merge-safe (first 25)

| Row | seller-sku | ASIN | Reasons |
|-----|------------|------|---------|
${data.queue_sample_importable
  .map(
    (q) =>
      `| ${q.row} | \`${q.seller_sku}\` | \`${q.asin}\` | ${q.reasons.join(", ")} |`,
  )
  .join("\n")}

## Sample — review-required / conflict (first 40)

| Row | seller-sku | ASIN | Class | Reasons |
|-----|------------|------|-------|---------|
${data.queue_sample_review
  .map(
    (q) =>
      `| ${q.row} | \`${q.seller_sku}\` | \`${q.asin}\` | ${q.merge_class} | ${q.reasons.join(", ")} |`,
  )
  .join("\n")}

## Next operator actions

1. Run **staging match census** on ${data.importable_merge_safe_count} merge-safe rows.
2. Triage **${s.duplicate_asin_keys}** duplicate-ASIN keys — confirm variant keys (no dimension conflict in sheet).
3. Decide whether **${Number(s.total_rows) - Number(s.parseable_lwh)}** dim-empty rows get structure-only profiles or remain out of scope.
4. Sign packaging import approval (separate file) before any \`product_packaging_*\` INSERT.
`;

  fs.writeFileSync(path.join(outDir, "canonical-column-mapping.md"), canonicalColumnMapping);
  fs.writeFileSync(path.join(outDir, "merge-strategy.md"), mergeStrategy);
  fs.writeFileSync(path.join(outDir, "overwrite-rules.md"), overwriteRules);
  fs.writeFileSync(path.join(outDir, "evidence-priority-rules.md"), evidencePriority);
  fs.writeFileSync(path.join(outDir, "review-required-queue.md"), reviewQueue);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PRODUCT DIMENSIONS CANONICAL MAPPING PLAN",
        run_id: runId,
        read_only: true,
        no_db_writes: true,
        intake_run_id: INTAKE_RUN,
        sheet_url: SHEET_URL,
        summary: s,
        intake_summary: intakeSummary,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, outDir, summary: s }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
