/**
 * NEXT-PRODUCT-ID-15 — Wave 1a staged UPDATE for public.amazon_fba_inventory (638 rows).
 *
 * - Preimage + dry run: uses NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * - Transactional UPDATE: requires DIRECT_POSTGRES_URL (or DATABASE_URL / SUPABASE_DB_URL).
 *
 *   npx tsx scripts/product-id-15-wave-1a-execute.ts
 *   npx tsx scripts/product-id-15-wave-1a-execute.ts --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

import { mkRunDir, mkRunId } from "../lib/audits/product-seed-output";

const ELIGIBLE_CSV = path.join(
  process.cwd(),
  ".cursor",
  "audit-reports",
  "next-product-id-11",
  "20260513T231500Z",
  "wave-1a-eligible-pks.csv",
);

const EXPECTED = 638;
const SELECT_COLS =
  "id,resolved_product_id,resolved_catalog_product_id,identifier_resolution_status,identifier_resolution_confidence,updated_at";

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

type StagingRow = {
  source_row_id: string;
  organization_id: string;
  store_id: string | null;
  proposed_product_id: string;
};

function parseCsv(): StagingRow[] {
  const raw = fs.readFileSync(ELIGIBLE_CSV, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iSrc = idx("source_row_id");
  const iOrg = idx("organization_id");
  const iStore = idx("store_id");
  const iHit = idx("existing_product_id_hit");
  if (iSrc < 0 || iOrg < 0 || iHit < 0) throw new Error("CSV missing required columns.");
  const rows: StagingRow[] = [];
  for (let n = 1; n < lines.length; n++) {
    const parts = lines[n].split(",");
    if (parts.length < header.length) continue;
    const source_row_id = parts[iSrc]?.trim();
    const organization_id = parts[iOrg]?.trim();
    const store_id = iStore >= 0 ? (parts[iStore]?.trim() || null) : null;
    const proposed = parts[iHit]?.trim();
    if (!source_row_id || !organization_id || !proposed) continue;
    rows.push({
      source_row_id,
      organization_id,
      store_id: store_id && store_id.length > 0 ? store_id : null,
      proposed_product_id: proposed,
    });
  }
  return rows;
}

function getPgUrl(): string | null {
  const u =
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim();
  return u || null;
}

async function fetchPreimageBatched(sb: SupabaseClient, ids: string[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const batch = 100;
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    const { data, error } = await sb
      .from("amazon_fba_inventory")
      .select(SELECT_COLS)
      .in("id", slice);
    if (error) throw new Error(`Preimage select: ${error.message}`);
    for (const r of (data ?? []) as Record<string, unknown>[]) out.push(r);
  }
  return out;
}

function writeArtifactsSkipped(outDir: string, runId: string, reason: string, detail: string): void {
  fs.writeFileSync(
    path.join(outDir, "execution-summary.md"),
    `# Execution summary — NEXT-PRODUCT-ID-15\n\n**Run ID:** \`${runId}\`\n\n**Status:** SKIPPED\n\n**Reason:** ${reason}\n\n${detail}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(outDir, "update-row-count-check.md"), "# Update row count\n\nNo UPDATE executed.\n", "utf8");
  fs.writeFileSync(path.join(outDir, "post-update-verify.md"), "# Post-update verify\n\nN/A — no UPDATE.\n", "utf8");
  fs.writeFileSync(
    path.join(outDir, "rollback-readiness.md"),
    "# Rollback readiness\n\nN/A — no UPDATE. Preimage CSV may still exist in this folder if Supabase preimage ran.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "no-extra-row-confirmation.md"),
    "# No extra row confirmation\n\nN/A — no UPDATE.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      { auditPrompt: "NEXT-PRODUCT-ID-15", runId, rowsUpdated: null, verifyStatus: "skipped", rollbackStatus: "n_a" },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function main(): Promise<void> {
  loadEnvLocal();
  const execute = process.argv.includes("--execute");
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "next-product-id-15"), runId);
  const logPath = path.join(outDir, "logs", "product-id-15.ndjson");
  const append = (o: Record<string, unknown>) =>
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n", "utf8");

  append({ event: "start", runId, execute, expected: EXPECTED });

  const staging = parseCsv();
  if (staging.length !== EXPECTED) {
    throw new Error(`Expected ${EXPECTED} CSV rows, got ${staging.length}`);
  }
  append({ event: "csv_parsed", rows: staging.length });

  const sb = createServiceClient();
  const ids = staging.map((r) => r.source_row_id);

  const preimageRows = await fetchPreimageBatched(sb, ids);
  append({ event: "preimage_fetched", rows: preimageRows.length });

  fs.writeFileSync(
    path.join(outDir, "preimage-wave-1a.csv"),
    [
      "id,resolved_product_id,resolved_catalog_product_id,identifier_resolution_status,identifier_resolution_confidence,updated_at",
      ...preimageRows.map((r) =>
        [
          String(r.id ?? ""),
          r.resolved_product_id != null ? String(r.resolved_product_id) : "",
          r.resolved_catalog_product_id != null ? String(r.resolved_catalog_product_id) : "",
          r.identifier_resolution_status != null ? String(r.identifier_resolution_status) : "",
          r.identifier_resolution_confidence != null ? String(r.identifier_resolution_confidence) : "",
          r.updated_at != null ? String(r.updated_at) : "",
        ].join(","),
      ),
    ].join("\n"),
    "utf8",
  );
  append({ event: "preimage_csv_written" });

  if (preimageRows.length !== EXPECTED) {
    writeArtifactsSkipped(
      outDir,
      runId,
      "preimage_row_mismatch",
      `Expected ${EXPECTED} rows from DB, got ${preimageRows.length}.`,
    );
    append({ event: "skipped", reason: "preimage_row_mismatch" });
    throw new Error(`Preimage returned ${preimageRows.length} rows, expected ${EXPECTED}`);
  }

  for (const r of preimageRows) {
    if (r.resolved_product_id != null) {
      writeArtifactsSkipped(
        outDir,
        runId,
        "preimage_not_null",
        `Row ${String(r.id)} already has resolved_product_id.`,
      );
      append({ event: "skipped", reason: "resolved_already_set", id: r.id });
      throw new Error(`Preimage check failed: id ${String(r.id)} already has resolved_product_id set.`);
    }
  }
  append({ event: "preimage_all_null_resolved_product_id" });

  if (!execute) {
    fs.writeFileSync(
      path.join(outDir, "execution-summary.md"),
      `# Execution summary — NEXT-PRODUCT-ID-15\n\n**Run ID:** \`${runId}\`\n\n**Mode:** dry run (no \`--execute\`).\n\n- CSV rows: ${EXPECTED}\n- Preimage rows: ${preimageRows.length}\n- All \`resolved_product_id\` null: yes\n- Preimage CSV: \`preimage-wave-1a.csv\`\n\nRe-run with \`--execute\` and \`DIRECT_POSTGRES_URL\` for transactional UPDATE.\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "update-row-count-check.md"),
      "# Update row count\n\nDry run only — **0** rows updated.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "post-update-verify.md"),
      "# Post-update verify\n\nDry run — no post-update SQL executed.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "rollback-readiness.md"),
      "# Rollback readiness\n\nPreimage captured in this folder. No UPDATE applied.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "no-extra-row-confirmation.md"),
      "# No extra row confirmation\n\nNo UPDATE in dry run.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          auditPrompt: "NEXT-PRODUCT-ID-15",
          runId,
          rowsUpdated: 0,
          verifyStatus: "dry_run_only",
          rollbackStatus: "preimage_saved",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    append({ event: "dry_run_end" });
    console.log(`Dry run OK → ${outDir} (add --execute + DIRECT_POSTGRES_URL to apply)`);
    return;
  }

  const pgUrl = getPgUrl();
  if (!pgUrl) {
    const detail =
      "Set DIRECT_POSTGRES_URL (or DATABASE_URL) in .env.local for a single BEGIN/COMMIT UPDATE, " +
      "or run the SQL block manually from .cursor/prompts/NEXT-PRODUCT-ID-15_STAGED_UPDATE_IMPLEMENTATION.md.";
    writeArtifactsSkipped(outDir, runId, "no_direct_postgres_url", detail);
    append({ event: "skipped", reason: "no_direct_postgres_url" });
    console.error(detail);
    process.exit(2);
  }

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  append({ event: "pg_connected" });

  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE wave_1a_staging (
        source_row_id uuid NOT NULL PRIMARY KEY,
        organization_id uuid NOT NULL,
        store_id uuid,
        proposed_product_id uuid NOT NULL
      ) ON COMMIT DROP`,
    );

    const insChunk = 80;
    for (let i = 0; i < staging.length; i += insChunk) {
      const slice = staging.slice(i, i + insChunk);
      const placeholders = slice
        .map((_, j) => {
          const o = j * 4;
          return `($${o + 1}::uuid,$${o + 2}::uuid,$${o + 3}::uuid,$${o + 4}::uuid)`;
        })
        .join(", ");
      const params = slice.flatMap((r) => [
        r.source_row_id,
        r.organization_id,
        r.store_id,
        r.proposed_product_id,
      ]);
      await client.query(
        `INSERT INTO wave_1a_staging (source_row_id, organization_id, store_id, proposed_product_id) VALUES ${placeholders}`,
        params,
      );
    }

    const upd = await client.query(
      `UPDATE public.amazon_fba_inventory AS afi
       SET
         resolved_product_id = st.proposed_product_id,
         resolved_catalog_product_id = NULL,
         identifier_resolution_status = 'resolved',
         identifier_resolution_confidence = 0.95,
         updated_at = now()
       FROM wave_1a_staging AS st
       WHERE afi.id = st.source_row_id
         AND afi.organization_id = st.organization_id
         AND afi.store_id IS NOT DISTINCT FROM st.store_id
         AND afi.resolved_product_id IS NULL`,
    );

    const updated = upd.rowCount ?? 0;
    append({ event: "update_complete", rowCount: updated });

    if (updated !== EXPECTED) {
      await client.query("ROLLBACK");
      append({ event: "rollback", reason: "row_count_mismatch", updated });
      throw new Error(`UPDATE rowCount=${updated}, expected ${EXPECTED}. Rolled back.`);
    }

    await client.query("COMMIT");
    append({ event: "commit" });

    const post = await client.query(
      `SELECT
         count(*)::int AS total_wave,
         count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
         count(*) FILTER (WHERE identifier_resolution_status = 'resolved')::int AS status_resolved,
         count(DISTINCT resolved_product_id)::int AS distinct_products
       FROM public.amazon_fba_inventory
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const pr = post.rows[0] as Record<string, number>;
    append({ event: "post_verify", row: pr });

    await client.end();

    const verifyOk =
      pr.total_wave === EXPECTED && pr.resolved === EXPECTED && pr.status_resolved === EXPECTED;

    fs.writeFileSync(
      path.join(outDir, "execution-summary.md"),
      `# Execution summary — NEXT-PRODUCT-ID-15\n\n**Run ID:** \`${runId}\`\n\n- **Rows updated:** ${updated}\n- **Transaction:** COMMIT\n- Preimage CSV: \`preimage-wave-1a.csv\`\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "update-row-count-check.md"),
      `# Update row count check\n\n- Expected: **${EXPECTED}**\n- UPDATE \`rowCount\`: **${updated}**\n- Match: **${updated === EXPECTED ? "yes" : "no"}**\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "post-update-verify.md"),
      `# Post-update verify\n\n\`\`\`json\n${JSON.stringify(pr, null, 2)}\n\`\`\`\n\n- **Verify pass:** ${verifyOk ? "yes" : "no"} (expect total_wave = resolved = status_resolved = ${EXPECTED}).\n- **Distinct resolved_product_id:** ${pr.distinct_products} (sanity: should be ≤ ${EXPECTED}).\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "rollback-readiness.md"),
      `# Rollback readiness\n\n- Preimage saved: \`preimage-wave-1a.csv\`\n- On failure after COMMIT, use manual rollback from preimage per \`rollback-plan.md\` in next-product-id-11 pack.\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "no-extra-row-confirmation.md"),
      `# No extra row confirmation\n\n- UPDATE scoped to Wave 1a staging join only; **${updated}** rows reported by PostgreSQL.\n- No \`products\` or \`product_identifier_map\` writes from this script.\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          auditPrompt: "NEXT-PRODUCT-ID-15",
          runId,
          rowsUpdated: updated,
          verifyStatus: verifyOk ? "pass" : "fail_post_counts",
          rollbackStatus: "preimage_saved_manual_rollback_available",
          postVerify: pr,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    append({ event: "complete", verifyOk });
    console.log(`NEXT-PRODUCT-ID-15 → ${outDir}`);
    console.log(JSON.stringify({ rowsUpdated: updated, postVerify: pr, verifyOk }, null, 2));

    if (!verifyOk) process.exit(1);
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    append({ event: "error", message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
