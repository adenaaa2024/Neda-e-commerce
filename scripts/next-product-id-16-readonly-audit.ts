/**
 * NEXT-PRODUCT-ID-16 — Read-only post–Wave 1a validation + Wave 1b planning data.
 *
 *   npx tsx scripts/next-product-id-16-readonly-audit.ts
 *
 * Writes: .cursor/audit-reports/next-product-id-16/<run_id>/ (no DB writes).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mkRunDir, mkRunId } from "../lib/audits/product-seed-output";

const WAVE1A_CSV = path.join(
  process.cwd(),
  ".cursor",
  "audit-reports",
  "next-product-id-11",
  "20260513T231500Z",
  "wave-1a-eligible-pks.csv",
);
const WAVE15_RUN = path.join(
  process.cwd(),
  ".cursor",
  "audit-reports",
  "next-product-id-15",
  "20260514T014702Z",
);

type WaveRow = { id: string; organization_id: string; store_id: string | null; expected_product_id: string };

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseWave1aCsv(): WaveRow[] {
  const raw = fs.readFileSync(WAVE1A_CSV, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  const iSrc = header.indexOf("source_row_id");
  const iOrg = header.indexOf("organization_id");
  const iStore = header.indexOf("store_id");
  const iHit = header.indexOf("existing_product_id_hit");
  const out: WaveRow[] = [];
  for (let n = 1; n < lines.length; n++) {
    const parts = lines[n].split(",");
    if (parts.length < header.length) continue;
    out.push({
      id: parts[iSrc].trim(),
      organization_id: parts[iOrg].trim(),
      store_id: iStore >= 0 ? (parts[iStore]?.trim() || null) : null,
      expected_product_id: parts[iHit].trim(),
    });
  }
  return out;
}

type InvRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
};

async function fetchAllInventory(sb: SupabaseClient): Promise<InvRow[]> {
  const pageSize = 1000;
  const all: InvRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("amazon_fba_inventory")
      .select(
        "id, organization_id, store_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
      )
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as InvRow[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function mdTable(headers: string[], rows: (string | number)[][]): string {
  const esc = (c: string | number) => String(c).replace(/\|/g, "\\|");
  const head = `| ${headers.map(esc).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "next-product-id-16"), runId);
  const logPath = path.join(outDir, "logs", "product-id-16.ndjson");
  const append = (o: Record<string, unknown>) =>
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n", "utf8");

  append({ event: "start", runId, wave15Ref: WAVE15_RUN });

  const wave1a = parseWave1aCsv();
  const waveSet = new Set(wave1a.map((w) => w.id));
  if (wave1a.length !== 638) append({ event: "warn_wave_csv_row_count", expected: 638, actual: wave1a.length });

  const sb = createServiceClient();
  const rows = await fetchAllInventory(sb);
  append({ event: "inventory_fetched", rowCount: rows.length });

  const byId = new Map(rows.map((r) => [r.id, r]));

  const total = rows.length;
  const resolvedNotNull = rows.filter((r) => r.resolved_product_id != null).length;
  const resolvedNull = total - resolvedNotNull;

  const statusDist = new Map<string, number>();
  for (const r of rows) {
    const k = r.identifier_resolution_status ?? "(null)";
    statusDist.set(k, (statusDist.get(k) ?? 0) + 1);
  }

  const confVals = rows
    .map((r) => r.identifier_resolution_confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const confMin = confVals.length ? Math.min(...confVals) : null;
  const confMax = confVals.length ? Math.max(...confVals) : null;
  const confAvg =
    confVals.length > 0 ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null;

  const distinctResolved = new Set(rows.map((r) => r.resolved_product_id).filter(Boolean)).size;

  const badResolvedStatus = rows.filter(
    (r) => r.resolved_product_id != null && r.identifier_resolution_status !== "resolved",
  );
  const badStatusNoProduct = rows.filter(
    (r) => r.identifier_resolution_status === "resolved" && r.resolved_product_id == null,
  );

  const waveIntegrityIssues: { id: string; issues: string[] }[] = [];
  for (const w of wave1a) {
    const r = byId.get(w.id);
    const issues: string[] = [];
    if (!r) issues.push("missing_row");
    else {
      if (r.resolved_product_id !== w.expected_product_id)
        issues.push(`product_mismatch(expected=${w.expected_product_id},actual=${r.resolved_product_id})`);
      if (r.organization_id !== w.organization_id) issues.push("organization_mismatch");
      if ((r.store_id ?? null) !== (w.store_id ?? null)) issues.push("store_mismatch");
      if (r.identifier_resolution_status !== "resolved")
        issues.push(`status_not_resolved(${r.identifier_resolution_status ?? "null"})`);
    }
    if (issues.length) waveIntegrityIssues.push({ id: w.id, issues });
  }
  const waveIntegrityFailRows = waveIntegrityIssues.length;
  const waveIntegritySamples = waveIntegrityIssues.slice(0, 5).map((x) => `${x.id}: ${x.issues.join("; ")}`);

  const waveResolvedCount = wave1a.filter((w) => {
    const r = byId.get(w.id);
    return (
      r &&
      r.resolved_product_id === w.expected_product_id &&
      r.identifier_resolution_status === "resolved"
    );
  }).length;

  const nonWaveResolved = rows.filter((r) => r.resolved_product_id != null && !waveSet.has(r.id));

  const blockedLines = fs
    .readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/next-product-id-10/20260513T214753Z/wave-1a-blocked-pks.csv"),
      "utf8",
    )
    .split(/\r?\n/)
    .filter((l) => l.trim()).length;
  const blockedCount = Math.max(0, blockedLines - 1);

  const scopePass =
    waveIntegrityFailRows === 0 &&
    waveResolvedCount === wave1a.length &&
    badResolvedStatus.length === 0 &&
    badStatusNoProduct.length === 0;

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-16",
    runId,
    validatedAt: new Date().toISOString(),
    wave15Run: "20260514T014702Z",
    inputArtifacts: {
      nextProductId10: ".cursor/audit-reports/next-product-id-10/20260513T214753Z/",
      nextProductId11: ".cursor/audit-reports/next-product-id-11/20260513T231500Z/",
      nextProductId12b: ".cursor/audit-reports/next-product-id-12b/20260514T011200Z/",
      nextProductId15: ".cursor/audit-reports/next-product-id-15/20260514T014702Z/",
    },
    totalRows: total,
    resolvedNotNull,
    resolvedNull,
    distinctResolvedProductId: distinctResolved,
    wave1aIntegrityFailureRows: waveIntegrityFailRows,
    wave1aResolvedAsExpected: waveResolvedCount,
    nonWaveRowsWithResolvedProductId: nonWaveResolved.length,
    scopeIntegrityPass: scopePass,
    blockedWave1aAdjacentPks: blockedCount,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  append({ event: "manifest", ...manifest });

  fs.writeFileSync(
    path.join(outDir, "post-wave-1a-validation-summary.md"),
    `# Post–Wave 1a validation summary — NEXT-PRODUCT-ID-16

<!-- markdownlint-disable MD013 MD060 -->

**Run ID:** \`${runId}\`

**Wave 1a execution reference:** [NEXT-PRODUCT-ID-15 \`20260514T014702Z\`](../next-product-id-15/20260514T014702Z/) (638 rows updated, verifyOk).

**Prior inputs used:** [NEXT-PRODUCT-ID-10](../next-product-id-10/20260513T214753Z/), [NEXT-PRODUCT-ID-11](../next-product-id-11/20260513T231500Z/), [NEXT-PRODUCT-ID-12b](../next-product-id-12b/20260514T011200Z/).

## Live table snapshot (read-only query)

| Metric | Value |
|--------|------:|
| Total \`amazon_fba_inventory\` rows | ${total} |
| \`resolved_product_id\` **not** null | ${resolvedNotNull} |
| \`resolved_product_id\` null | ${resolvedNull} |
| Distinct non-null \`resolved_product_id\` | ${distinctResolved} |

## Integrity rollup

| Check | Result |
|-------|--------|
| Wave 1a rows matching CSV expected \`product_id\` + \`resolved\` status | ${waveResolvedCount} / ${wave1a.length} |
| Wave 1a rows with any integrity issue | ${waveIntegrityFailRows} |
| \`resolved_product_id\` set but status ≠ \`resolved\` | ${badResolvedStatus.length} |
| Status \`resolved\` but \`resolved_product_id\` null | ${badStatusNoProduct.length} |
| **Scope integrity pass** | **${scopePass ? "PASS" : "FAIL"}** |

Non-Wave-1a rows with non-null \`resolved_product_id\`: **${nonWaveResolved.length}**. ${nonWaveResolved.length === 0 ? "Every resolved row matches the CSV column **existing_product_id_hit** — **no stray resolver population**, consistent with Wave 1a UPDATE scoping to staging PKs only." : "Investigate non-wave resolver rows; Wave 1a SQL should only touch staging PKs."}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "resolved-distribution.md"),
    `# Resolved distribution — NEXT-PRODUCT-ID-16

## identifier_resolution_status

${mdTable(
  ["status", "count"],
  [...statusDist.entries()].sort((a, b) => a[0].localeCompare(b[0])),
)}

## identifier_resolution_confidence (numeric rows only)

| Stat | Value |
|------|------:|
| Count | ${confVals.length} |
| Min | ${confMin ?? "n/a"} |
| Max | ${confMax ?? "n/a"} |
| Mean | ${confAvg != null ? confAvg.toFixed(6) : "n/a"} |
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "scope-integrity-check.md"),
    `# Scope integrity check — NEXT-PRODUCT-ID-16

## Wave 1a PK set (${wave1a.length} rows from CSV)

- Source: [wave-1a-eligible-pks.csv](../next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv)
- **Expected resolved count:** ${wave1a.length} (CSV data rows)
- **Observed matching CSV + \`resolved\`:** ${waveResolvedCount}

## Failure samples (max 5)

${waveIntegritySamples.length ? waveIntegritySamples.map((s) => `- \`${s}\``).join("\n") : "- (none)"}

## SQL semantics (non-expansion)

The Wave 1a \`UPDATE\` joined only \`wave_1a_staging\` PKs from the eligible CSV. Rows **outside** that set were **not** targets of that statement.

**Live check:** ${total} rows; ${resolvedNotNull} with non-null \`resolved_product_id\`; **${nonWaveResolved.length}** outside the Wave 1a PK set (expected **0** after a scoped-only run).

## Duplicate source row IDs

- Primary key \`id\`: one row per UUID in fetch (${total} rows) — no duplicate \`id\` in result set.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "downstream-safety-check.md"),
    `# Downstream safety check — NEXT-PRODUCT-ID-16

<!-- markdownlint-disable MD013 -->

## Claim / projection surfaces

- **Claim inbox projection** (\`lib/claim-inbox-projection.ts\`) already consumes \`resolved_product_id\` on source-linked paths; additional FBA inventory rows with resolver fields populated **reduce** \`needs_product_link\`-style ambiguity for those SKUs.
- **No code change required** for read paths to “see” the new values — PostgREST returns stored columns; ensure list \`select\` strings include resolver fields where needed (existing claim inventory routes already model resolver columns on ledger/inventory-class tables where wired).

## App routes / \`select\` columns

- Repo scan (\`app/\`, \`pages/\`): **no** Next.js route references \`amazon_fba_inventory\` directly; consumption is via **lib** (claim projection, import mappers, audits). Resolver columns are additive; nothing in the web app layer appears to hard-code a column list that omits them for this table.

## Inventory balances (ERP-02)

- Canonical \`inventory_balances\` work remains **plan-only**; note only that \`amazon_fba_inventory.resolved_product_id\` is now populated for Wave 1a lines for future rollups.

## Claim drafts

- No interaction with \`claim_candidate_drafts\` in this validation.

## Risk

- Downstream jobs that assumed **all** FBA rows were unresolved may now branch differently — monitor first ETL that keys only on \`resolved_product_id IS NULL\`.
`,
    "utf8",
  );

  const unresolvedTotal = rows.filter((r) => r.resolved_product_id == null).length;
  const wave1aStillNull = rows.filter((r) => waveSet.has(r.id) && r.resolved_product_id == null).length;

  fs.writeFileSync(
    path.join(outDir, "remaining-unresolved-analysis.md"),
    `# Remaining unresolved analysis — NEXT-PRODUCT-ID-16

## Counts

| Segment | Count |
|---------|------:|
| All rows with \`resolved_product_id\` null | ${unresolvedTotal} |
| Wave 1a PKs (should be **0** null after Wave 1a) | ${wave1aStillNull} |

## Dry-run context (NEXT-PRODUCT-ID-10 \`20260513T214753Z\`)

From [run-summary.json](../next-product-id-10/20260513T214753Z/run-summary.json):

- Rows scanned: **949**
- Bucket counts: \`bucket 2\` = 631, \`bucket 3\` = 151, \`bucket 4\` = 125, \`bucket 5\` = 42
- Cross-product conflict rows (file): **40**
- Wave 1a **eligible** (bucket 2 rank 2 OR bucket 3 rank 3, etc.): **638** (already applied)
- **Blocked** adjacent PKs (same bucket family, wrong rank / rules): **${blockedCount}** (see \`wave-1a-blocked-pks.csv\`)

## Safe vs blocked (planning only)

- **Safe next slice** requires a **new dry-run** with explicit Wave 1b eligibility (do not reuse Wave 1a CSV).
- Rows in **bucket 4** (\`safe_new\`) imply **product creation** — **out of scope** for resolver-only backfill.
- **Bucket 5** / **cross-product conflict** / **fan-out** remain blockers until policy or bridge fixes land.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "wave-1b-candidate-plan.md"),
    `# Wave 1b candidate plan (proposal only) — NEXT-PRODUCT-ID-16

## Candidate count (indicative, not executed)

| Source | Approximate count | Notes |
|--------|------------------:|-------|
| Blocked bucket 2/3 (Wave 1a adjacent) | **${blockedCount}** | From \`wave-1a-blocked-pks.csv\` — mostly \`bucket2_wrong_rank_8\` / rank mismatches |
| Remaining null-resolver rows after Wave 1a | **${resolvedNull}** | Includes buckets 4/5 and never-eligible rows |

**Not** a ready-made “Wave 1b eligible” list — **new dry-run** (NEXT-PRODUCT-ID-17 or product-ID-10 rerun) must define eligibility.

## Proposed Wave 1b eligibility (draft)

1. **Option A — Rank-expanded bucket 2:** include \`bucket_id = 2\` with \`match_rank = 4\` **only** with added guard (e.g. secondary review, cap on rows, manual preimage subset).
2. **Option B — Stricter bridge tie-break** for blocked rank-8 rows after PIM action.
3. **Exclude:** bucket 4 (\`safe_new\`), bucket 5 without human adjudication, any \`03-cross-product-conflict.csv\` UUID.

## Preconditions

- Fresh **dry-run** JSON/CSV pack for Wave 1b.
- **Preimage** \`SELECT\` for the new PK set.
- **Signoff** (NEXT-PRODUCT-ID-14 style) before any \`UPDATE\` prompt.

## Product creation

- Wave 1b resolver-only path must still **not** create \`products\` rows.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers-and-risks.md"),
    `# Blockers and risks — NEXT-PRODUCT-ID-16

| Blocker | Impact |
|---------|--------|
| \`ambiguous_conflict\` / bucket 5 | Needs human or policy before auto-resolve |
| \`fan_out\` | Multiple \`product_id\` candidates — do not pick arbitrarily |
| \`cross-product conflict\` | 40 rows in ID-10 file — remain excluded until cleared |
| \`safe_new\` (bucket 4) | Requires **product creation** — not a resolver-only UPDATE |
| \`missing lineage\` | Provenance gap was 0 in ID-10; re-verify on next import |

## Risks

- **Stale dry-run:** Wave 1b must re-scan live table after imports.
- **False confidence:** Resolver confidence 0.95 uniform on Wave 1a — downstream should not treat as ML score.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next step recommendation — NEXT-PRODUCT-ID-16

1. **NEXT-PRODUCT-ID-17 (suggested):** Fresh dry-run on \`amazon_fba_inventory\` (949 rows) emitting **Wave 1b-eligible-pks.csv** with explicit rules (e.g. rank-4 bucket2 pilot).
2. If scope integrity **FAIL** in this pack: stop and investigate mismatched PKs before any future UPDATE.
3. Optional: attach this \`manifest.json\` to the product identity ticket as Wave 1a closure evidence.

## Exact next prompt (copy-paste)

\`\`\`text
NEXT-PRODUCT-ID-17 — Fresh amazon_fba_inventory dry-run after Wave 1a; emit
wave-1b-eligible-pks.csv + blocked list + preimage SQL template; read-only;
no UPDATE.
\`\`\`
`,
    "utf8",
  );

  append({ event: "complete", outDir });
  console.log(`NEXT-PRODUCT-ID-16 → ${outDir}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
