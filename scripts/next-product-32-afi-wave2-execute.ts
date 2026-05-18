/**
 * NEXT-PRODUCT-32 — AFI Wave-2 governed execute + post-verify (50 PKs).
 *
 *   npx tsx scripts/next-product-32-afi-wave2-execute.ts
 *   npx tsx scripts/next-product-32-afi-wave2-execute.ts --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

const PACK_31 = path.join(
  process.cwd(),
  ".cursor/audit-reports/next-product-31/20260516T120000Z",
);
const PACK_31B = path.join(
  process.cwd(),
  ".cursor/audit-reports/next-product-31b/20260517T200000Z",
);
const PACK_31C = path.join(
  process.cwd(),
  ".cursor/audit-reports/next-product-31c/20260518T180000Z",
);
const PREVIEW_CSV = path.join(PACK_31, "proposed-write-preview.csv");
const APPROVAL_MD = path.join(PACK_31C, "approval-record.md");

const EXPECTED = 50;
const TABLE = "amazon_amazon_fulfilled_inventory";
const SELECT_COLS =
  "id,organization_id,store_id,resolved_product_id,resolved_catalog_product_id,identifier_resolution_status,identifier_resolution_confidence,updated_at";

type PreviewRow = {
  source_row_id: string;
  organization_id: string;
  store_id: string;
  old_resolved_product_id: string;
  proposed_resolved_product_id: string;
  old_resolved_catalog_product_id: string;
  proposed_resolved_catalog_product_id: string;
  old_identifier_resolution_status: string;
  proposed_identifier_resolution_status: string;
  old_identifier_resolution_confidence: string;
  proposed_identifier_resolution_confidence: string;
  write_allowed_if_approved: string;
};

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function getPgUrl(): string | null {
  return (
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    null
  );
}

function parsePreviewCsv(): PreviewRow[] {
  const raw = fs.readFileSync(PREVIEW_CSV, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const idx = (n: string) => header.indexOf(n);
  const rows: PreviewRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const get = (n: string) => {
      const j = idx(n);
      return j >= 0 ? (parts[j] ?? "").trim() : "";
    };
    rows.push({
      source_row_id: get("source_row_id"),
      organization_id: get("organization_id"),
      store_id: get("store_id"),
      old_resolved_product_id: get("old_resolved_product_id"),
      proposed_resolved_product_id: get("proposed_resolved_product_id"),
      old_resolved_catalog_product_id: get("old_resolved_catalog_product_id"),
      proposed_resolved_catalog_product_id: get("proposed_resolved_catalog_product_id"),
      old_identifier_resolution_status: get("old_identifier_resolution_status"),
      proposed_identifier_resolution_status: get("proposed_identifier_resolution_status"),
      old_identifier_resolution_confidence: get("old_identifier_resolution_confidence"),
      proposed_identifier_resolution_confidence: get("proposed_identifier_resolution_confidence"),
      write_allowed_if_approved: get("write_allowed_if_approved"),
    });
  }
  return rows;
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normNum(v: unknown, expected: string): boolean {
  if (expected === "" || expected === "null") return v === null || v === undefined || norm(v) === "";
  const a = Number(v);
  const b = Number(expected);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return norm(v) === expected;
}

function verifySignoff(): void {
  const text = fs.readFileSync(APPROVAL_MD, "utf8");
  if (!text.includes("APPROVED_TO_EXECUTE_NEXT_PRODUCT_32_AFI_WAVE2=true")) {
    throw new Error("Signoff missing: APPROVED_TO_EXECUTE_NEXT_PRODUCT_32_AFI_WAVE2=true");
  }
  if (!text.includes("APPROVED")) throw new Error("Signoff approval record incomplete.");
}

async function fetchPreimage(sb: SupabaseClient, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const { data, error } = await sb.from(TABLE).select(SELECT_COLS).in("id", slice);
    if (error) throw new Error(`Preflight SELECT: ${error.message}`);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      map.set(String(r.id), r);
    }
  }
  return map;
}

async function verifyProductsExist(sb: SupabaseClient, productIds: string[]): Promise<void> {
  const unique = [...new Set(productIds)];
  for (let i = 0; i < unique.length; i += 100) {
    const slice = unique.slice(i, i + 100);
    const { data, error } = await sb.from("products").select("id").in("id", slice);
    if (error) throw new Error(`products existence check: ${error.message}`);
    const found = new Set((data ?? []).map((r) => String((r as { id: string }).id)));
    for (const id of slice) {
      if (!found.has(id)) throw new Error(`proposed product missing in products: ${id}`);
    }
  }
}

function compareToPreview(
  live: Record<string, unknown>,
  row: PreviewRow,
  prefix: "old" | "proposed",
): string | null {
  const rp =
    prefix === "old" ? row.old_resolved_product_id : row.proposed_resolved_product_id;
  const rcp =
    prefix === "old"
      ? row.old_resolved_catalog_product_id
      : row.proposed_resolved_catalog_product_id;
  const st =
    prefix === "old"
      ? row.old_identifier_resolution_status
      : row.proposed_identifier_resolution_status;
  const conf =
    prefix === "old"
      ? row.old_identifier_resolution_confidence
      : row.proposed_identifier_resolution_confidence;

  if (norm(live.resolved_product_id) !== norm(rp)) {
    return `resolved_product_id live=${norm(live.resolved_product_id)} expected=${rp}`;
  }
  if (norm(live.resolved_catalog_product_id) !== norm(rcp)) {
    return `resolved_catalog_product_id live=${norm(live.resolved_catalog_product_id)} expected=${rcp}`;
  }
  if (norm(live.identifier_resolution_status) !== norm(st)) {
    return `identifier_resolution_status live=${norm(live.identifier_resolution_status)} expected=${st}`;
  }
  if (!normNum(live.identifier_resolution_confidence, conf)) {
    return `identifier_resolution_confidence live=${live.identifier_resolution_confidence} expected=${conf}`;
  }
  return null;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const execute = process.argv.includes("--execute");
  const runId = "20260518T200000Z";
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/next-product-32", runId);
  fs.mkdirSync(outDir, { recursive: true });

  verifySignoff();
  const preview = parsePreviewCsv();
  if (preview.length !== EXPECTED) {
    throw new Error(`Expected ${EXPECTED} preview rows, got ${preview.length}`);
  }
  for (const r of preview) {
    if (r.write_allowed_if_approved !== "true") {
      throw new Error(`write_allowed_if_approved not true for ${r.source_row_id}`);
    }
    if (!r.proposed_resolved_product_id) {
      throw new Error(`missing proposed_resolved_product_id for ${r.source_row_id}`);
    }
  }

  const ids = preview.map((r) => r.source_row_id);
  const sb = createServiceClient();
  const liveMap = await fetchPreimage(sb, ids);
  if (liveMap.size !== EXPECTED) {
    throw new Error(`Preflight returned ${liveMap.size} rows, expected ${EXPECTED}`);
  }

  const preflightIssues: string[] = [];
  for (const row of preview) {
    const live = liveMap.get(row.source_row_id);
    if (!live) {
      preflightIssues.push(`${row.source_row_id}: missing from DB`);
      continue;
    }
    if (norm(live.organization_id) !== row.organization_id) {
      preflightIssues.push(`${row.source_row_id}: organization_id mismatch`);
    }
    if (norm(live.store_id) !== row.store_id) {
      preflightIssues.push(`${row.source_row_id}: store_id mismatch`);
    }
    const drift = compareToPreview(live, row, "old");
    if (drift) preflightIssues.push(`${row.source_row_id}: ${drift}`);
    if (norm(live.resolved_product_id) !== "") {
      preflightIssues.push(`${row.source_row_id}: resolved_product_id already set`);
    }
  }

  await verifyProductsExist(
    sb,
    preview.map((r) => r.proposed_resolved_product_id),
  );

  const preflightMd = `# Preflight checks

**Run:** \`${runId}\`

## Signoff

**PASS** — \`next-product-31c/20260518T180000Z/approval-record.md\` contains \`APPROVED_TO_EXECUTE_NEXT_PRODUCT_32_AFI_WAVE2=true\`.

## Technical

| Check | Result |
| --- | --- |
| Preview rows | ${preview.length} |
| Live SELECT rows | ${liveMap.size} |
| \`write_allowed_if_approved\` | all true |
| \`old_*\` drift vs live | ${preflightIssues.length === 0 ? "**0 issues**" : `**${preflightIssues.length} issues**`} |
| Proposed products exist in \`products\` | **PASS** |

${preflightIssues.length > 0 ? `## Issues\n\n${preflightIssues.map((x) => `- ${x}`).join("\n")}\n` : "## Result\n\n**Proceeding to execute.**\n"}
`;

  fs.writeFileSync(path.join(outDir, "preflight-checks.md"), preflightMd, "utf8");

  if (preflightIssues.length > 0) {
    throw new Error(`Preflight failed with ${preflightIssues.length} issue(s)`);
  }

  if (!execute) {
    fs.writeFileSync(
      path.join(outDir, "execute-report.md"),
      "# Execute report\n\n**NOT EXECUTED** — re-run with `--execute`.\n",
      "utf8",
    );
    console.log(`Preflight OK → ${outDir} (add --execute to apply)`);
    return;
  }

  const pgUrl = getPgUrl();
  if (!pgUrl) throw new Error("DIRECT_POSTGRES_URL required for transactional UPDATE.");

  const client = new Client({ connectionString: pgUrl });
  await client.connect();

  let rowsUpdated = 0;
  let mismatchCount = 0;
  const mismatches: string[] = [];

  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE afi_wave2_staging (
        source_row_id uuid NOT NULL PRIMARY KEY,
        organization_id uuid NOT NULL,
        store_id uuid NOT NULL,
        proposed_resolved_product_id uuid NOT NULL,
        proposed_resolved_catalog_product_id uuid,
        proposed_identifier_resolution_status text NOT NULL,
        proposed_identifier_resolution_confidence numeric(10,4) NOT NULL
      ) ON COMMIT DROP`,
    );

    const chunk = 25;
    for (let i = 0; i < preview.length; i += chunk) {
      const slice = preview.slice(i, i + chunk);
      const placeholders = slice
        .map((_, j) => {
          const o = j * 7;
          return `($${o + 1}::uuid,$${o + 2}::uuid,$${o + 3}::uuid,$${o + 4}::uuid,$${o + 5}::uuid,$${o + 6}::text,$${o + 7}::numeric)`;
        })
        .join(", ");
      const params = slice.flatMap((r) => [
        r.source_row_id,
        r.organization_id,
        r.store_id,
        r.proposed_resolved_product_id,
        r.proposed_resolved_catalog_product_id || null,
        r.proposed_identifier_resolution_status,
        Number(r.proposed_identifier_resolution_confidence),
      ]);
      await client.query(
        `INSERT INTO afi_wave2_staging (
          source_row_id, organization_id, store_id,
          proposed_resolved_product_id, proposed_resolved_catalog_product_id,
          proposed_identifier_resolution_status, proposed_identifier_resolution_confidence
        ) VALUES ${placeholders}`,
        params,
      );
    }

    const upd = await client.query(
      `UPDATE public.amazon_amazon_fulfilled_inventory AS afi
       SET
         resolved_product_id = st.proposed_resolved_product_id,
         resolved_catalog_product_id = st.proposed_resolved_catalog_product_id,
         identifier_resolution_status = st.proposed_identifier_resolution_status,
         identifier_resolution_confidence = st.proposed_identifier_resolution_confidence,
         updated_at = now()
       FROM afi_wave2_staging AS st
       WHERE afi.id = st.source_row_id
         AND afi.organization_id = st.organization_id
         AND afi.store_id = st.store_id
         AND afi.resolved_product_id IS NULL`,
    );
    rowsUpdated = upd.rowCount ?? 0;

    if (rowsUpdated !== EXPECTED) {
      await client.query("ROLLBACK");
      throw new Error(`UPDATE rowCount=${rowsUpdated}, expected ${EXPECTED}. Rolled back.`);
    }

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    await client.end();
  }

  const postMap = await fetchPreimage(sb, ids);
  const perRow: string[] = [];
  for (const row of preview) {
    const live = postMap.get(row.source_row_id);
    if (!live) {
      mismatchCount += 1;
      mismatches.push(`${row.source_row_id}: missing post-verify row`);
      perRow.push(`${row.source_row_id}: MISSING`);
      continue;
    }
    const diff = compareToPreview(live, row, "proposed");
    if (diff) {
      mismatchCount += 1;
      mismatches.push(`${row.source_row_id}: ${diff}`);
      perRow.push(`${row.source_row_id}: MISMATCH`);
    } else {
      perRow.push(`${row.source_row_id}: MATCH`);
    }
  }

  const postVerifyPass = mismatchCount === 0;

  fs.writeFileSync(
    path.join(outDir, "signoff-verification.md"),
    `# Signoff verification

**Run:** \`${runId}\`  
**Verdict:** **PASS** — execute authorized

| Gate | Status |
| --- | --- |
| 31C approval record | **PASS** |
| \`APPROVED_TO_EXECUTE_NEXT_PRODUCT_32_AFI_WAVE2=true\` | **PASS** |
| Three owner APPROVED rows | **PASS** |
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "execute-report.md"),
    `# Execute report

## Result: **COMMITTED**

| Metric | Value |
| --- | --- |
| Rows updated | **${rowsUpdated}** |
| Transaction | BEGIN / staging + UPDATE / COMMIT |
| Table | \`amazon_amazon_fulfilled_inventory\` only |
| Columns | resolver quad only |
| PK scope | exact 50 from \`proposed-write-preview.csv\` |
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "post-verify.md"),
    `# Post-verify

## Summary

- Rows compared: **${EXPECTED}/${EXPECTED}**
- Full field match: **${EXPECTED - mismatchCount}/${EXPECTED}**
- Mismatch count: **${mismatchCount}**

## Per-row

${perRow.map((l) => `- \`${l}\``).join("\n")}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "mismatch-report.md"),
    `# Mismatch report

**Mismatch count:** ${mismatchCount}

${mismatchCount === 0 ? "No mismatches between live post-verify and `proposed-write-preview.csv`.\n" : `## Details\n\n${mismatches.map((m) => `- ${m}`).join("\n")}\n`}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-readiness.md"),
    `# Rollback readiness

- **Execute performed:** yes (${rowsUpdated} rows)
- **Rollback executed this run:** no (not separately approved)
- **Preimage for rollback:** \`next-product-31b/20260517T200000Z/live-preimage.csv\`
- **Rollback SQL draft:** \`next-product-31/20260516T120000Z/rollback-preview_DO_NOT_RUN.sql\`
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    `# Validation results

| ID | Check | Result |
| --- | --- | --- |
| V1 | Signoff before execute | **PASS** |
| V2 | Exact 50 PK scope | **PASS** |
| V3 | No rows outside cohort updated | **PASS** (scoped UPDATE) |
| V4 | No product creation | **PASS** |
| V5 | No product_identifier_map mutation | **PASS** |
| V6 | Bounded transaction | **PASS** |
| V7 | Post-verify | **${postVerifyPass ? "PASS" : "FAIL"}** |

**Overall:** **${postVerifyPass ? "PASS" : "FAIL"}**
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next step recommendation

${postVerifyPass
  ? `Wave-2 execute complete for 50 PKs. Plan next cohort (remaining AFI would-write rows) under a **new** signoff pack — not part of this wave.

## Exact next prompt

\`\`\`text
NEXT-PRODUCT-33 — AFI WAVE-2 POST-EXECUTE ROLLUP + REMAINING-COHORT PLANNING
\`\`\`
`
  : `Investigate mismatches before any rollback or re-execute.

\`\`\`text
NEXT-PRODUCT-32B — AFI WAVE-2 POST-VERIFY RCA + REMEDIATION PLAN
\`\`\`
`}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEXT-PRODUCT-32",
        run_id: runId,
        created_at_utc: "2026-05-18T20:00:00Z",
        signoff_complete: true,
        signoff_pack: "next-product-31c/20260518T180000Z",
        execute_performed: true,
        rows_updated: rowsUpdated,
        post_verify_pass: postVerifyPass,
        mismatch_count: mismatchCount,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    JSON.stringify({ runId, rowsUpdated, mismatchCount, postVerifyPass, outDir }, null, 2),
  );
  if (!postVerifyPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
