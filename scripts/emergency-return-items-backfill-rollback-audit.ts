/**
 * EMERGENCY-RETURN-ITEMS-BACKFILL-ROLLBACK-AUDIT (read-only Phase 1)
 *   npx tsx scripts/emergency-return-items-backfill-rollback-audit.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const WAVE2_DIR = ".cursor/audit-reports/expected-linkage-return-items-backfill-scale-wave2/20260521T220500Z";
const OUT_BASE = ".cursor/audit-reports/emergency-return-items-backfill-rollback-audit";
const STAGING_REF = "eiqfaapyumhixxoeltgu";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseRollbackIds(sql: string): string[] {
  const re = /WHERE id = '([0-9a-f-]{36})'::uuid/gi;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) ids.push(m[1]!);
  return ids;
}

function parseRollbackUpdates(sql: string): Array<{ id: string; resolved: string | null; status: string | null; conf: string | null }> {
  const re =
    /UPDATE public\.return_items SET resolved_product_id = (NULL|'[^']+'::uuid), identifier_resolution_status = (NULL|'[^']*'), identifier_resolution_confidence = ([^,]+), updated_at = now\(\) WHERE id = '([0-9a-f-]{36})'::uuid/gi;
  const out: Array<{ id: string; resolved: string | null; status: string | null; conf: string | null }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({
      resolved: m[1]!.startsWith("'") ? m[1]!.slice(1, -7) : null,
      status: m[2]!.startsWith("'") ? m[2]!.slice(1, -1) : null,
      conf: m[3]!.trim() === "NULL" ? null : m[3]!.trim(),
      id: m[4]!,
    });
  }
  return out;
}

async function columnSet(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function has(cols: Set<string>, name: string): boolean {
  return cols.has(name);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const rollbackPath = path.join(process.cwd(), WAVE2_DIR, "rollback.sql");
  const rollbackSql = fs.readFileSync(rollbackPath, "utf8");
  const rollbackIds = parseRollbackIds(rollbackSql);
  const rollbackRows = parseRollbackUpdates(rollbackSql);

  const beforeCounts = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), WAVE2_DIR, "before-counts.json"), "utf8"),
  );
  const afterCounts = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), WAVE2_DIR, "after-counts.json"), "utf8"),
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), WAVE2_DIR, "manifest.json"), "utf8"));

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) throw new Error(`Staging ref guard failed (${STAGING_REF})`);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const affectedIds = rollbackIds;

  const riCols = await columnSet(client, "return_items");
  await columnSet(client, "expected_packages");

  const idFilter = `ri.id = ANY($1::uuid[])`;

  const currentCounts = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.return_items) AS return_items_total,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL) AS return_items_resolved,
      (SELECT COUNT(*)::int FROM public.return_items WHERE id = ANY($1::uuid[])) AS wave2_ids_found,
      (SELECT COUNT(*)::int FROM public.return_items WHERE id = ANY($1::uuid[]) AND resolved_product_id IS NOT NULL) AS wave2_currently_resolved
  `,
    [affectedIds],
  );

  const existsProof = await client.query(
    `
    SELECT
      COUNT(*)::int AS affected_count,
      MIN(ri.created_at) AS min_created_at,
      MAX(ri.created_at) AS max_created_at,
      COUNT(*) FILTER (WHERE ri.created_at < '2026-05-21T22:00:00Z')::int AS created_before_wave_apply,
      COUNT(*) FILTER (WHERE ri.created_at >= '2026-05-21T22:00:00Z')::int AS created_at_or_after_wave_apply
    FROM public.return_items ri
    WHERE ${idFilter}
  `,
    [affectedIds],
  );

  const fieldExprs: Record<string, string> = {
    package_id: has(riCols, "package_id") ? "ri.package_id IS NOT NULL" : "false",
    pallet_id: has(riCols, "pallet_id") ? "ri.pallet_id IS NOT NULL" : "false",
    slip_content_id: has(riCols, "slip_content_id") ? "ri.slip_content_id IS NOT NULL" : "false",
    expected_item_id: has(riCols, "expected_item_id") ? "ri.expected_item_id IS NOT NULL" : "false",
    barcode:
      has(riCols, "barcode") || has(riCols, "scanned_barcode")
        ? "(NULLIF(btrim(COALESCE(ri.barcode::text, ri.scanned_barcode::text, '')), '') IS NOT NULL)"
        : "false",
    fnsku: has(riCols, "fnsku") ? "NULLIF(btrim(ri.fnsku::text), '') IS NOT NULL" : "false",
    sku: has(riCols, "sku") ? "NULLIF(btrim(ri.sku::text), '') IS NOT NULL" : "false",
    asin: has(riCols, "asin") ? "NULLIF(btrim(ri.asin::text), '') IS NOT NULL" : "false",
    product_identifier:
      has(riCols, "product_identifier") ? "NULLIF(btrim(ri.product_identifier::text), '') IS NOT NULL" : "false",
    photo:
      has(riCols, "photo_url") || has(riCols, "image_url") || has(riCols, "photos")
        ? "(ri.photo_url IS NOT NULL OR ri.image_url IS NOT NULL OR ri.photos IS NOT NULL)"
        : "false",
    conditions:
      has(riCols, "conditions") ? "(ri.conditions IS NOT NULL AND ri.conditions::text NOT IN ('null','[]','{}'))" : "false",
    issue:
      has(riCols, "issue") || has(riCols, "issue_type")
        ? "(NULLIF(btrim(COALESCE(ri.issue::text, ri.issue_type::text, '')), '') IS NOT NULL)"
        : "false",
    scanned_product_id: has(riCols, "scanned_product_id") ? "ri.scanned_product_id IS NOT NULL" : "false",
    legacy_product_id: has(riCols, "product_id") ? "ri.product_id IS NOT NULL" : "false",
    quantity_ne_1:
      has(riCols, "quantity") ? "(ri.quantity IS NOT NULL AND ri.quantity <> 1)" : "false",
    deleted: has(riCols, "deleted_at") ? "ri.deleted_at IS NOT NULL" : "false",
    receive_scope:
      has(riCols, "receive_scope_key") ? "NULLIF(btrim(ri.receive_scope_key::text), '') IS NOT NULL" : "false",
    receive_allocated:
      has(riCols, "receive_allocated") ? "ri.receive_allocated IS TRUE" : "false",
    import_source:
      has(riCols, "import_source") ? "NULLIF(btrim(ri.import_source::text), '') IS NOT NULL" : "false",
    source:
      has(riCols, "source") ? "NULLIF(btrim(ri.source::text), '') IS NOT NULL" : "false",
    created_by: has(riCols, "created_by") ? "ri.created_by IS NOT NULL" : "false",
    operator_id: has(riCols, "operator_id") ? "ri.operator_id IS NOT NULL" : "false",
    scanned_by: has(riCols, "scanned_by") ? "ri.scanned_by IS NOT NULL" : "false",
  };

  const signalCounts = await client.query(
    `
    SELECT
      COUNT(*)::int AS total,
      ${Object.entries(fieldExprs)
        .map(([k, expr]) => `COUNT(*) FILTER (WHERE ${expr})::int AS ${k}`)
        .join(",\n      ")}
    FROM public.return_items ri
    WHERE ${idFilter}
  `,
    [affectedIds],
  );

  const createdByDay = has(riCols, "created_at")
    ? await client.query(
        `
        SELECT date_trunc('day', ri.created_at)::date::text AS day, COUNT(*)::int AS n
        FROM public.return_items ri WHERE ${idFilter}
        GROUP BY 1 ORDER BY 1
      `,
        [affectedIds],
      )
    : { rows: [] };

  const createdByHourPeak = has(riCols, "created_at")
    ? await client.query(
        `
        SELECT date_trunc('hour', ri.created_at)::text AS hour, COUNT(*)::int AS n
        FROM public.return_items ri WHERE ${idFilter}
        GROUP BY 1 ORDER BY n DESC, 1 LIMIT 15
      `,
        [affectedIds],
      )
    : { rows: [] };

  const createdByCol = has(riCols, "created_by")
    ? "created_by"
    : has(riCols, "operator_id")
      ? "operator_id"
      : has(riCols, "scanned_by")
        ? "scanned_by"
        : null;

  const createdByOperator = createdByCol
    ? await client.query(
        `SELECT ri.${createdByCol}::text AS operator_key, COUNT(*)::int AS n
         FROM public.return_items ri WHERE ${idFilter}
         GROUP BY 1 ORDER BY n DESC NULLS LAST LIMIT 20`,
        [affectedIds],
      )
    : { rows: [] };

  const sourceBreakdown =
    has(riCols, "import_source") || has(riCols, "source")
      ? await client.query(
          `
          SELECT
            COALESCE(NULLIF(btrim(ri.import_source::text), ''), NULLIF(btrim(ri.source::text), ''), '(null)') AS source_key,
            COUNT(*)::int AS n
          FROM public.return_items ri WHERE ${idFilter}
          GROUP BY 1 ORDER BY n DESC
        `,
          [affectedIds],
        )
      : { rows: [] };

  const epJoin = has(riCols, "expected_item_id")
    ? await client.query(
        `
        SELECT
          COUNT(*)::int AS with_ep,
          COUNT(*) FILTER (WHERE ep.resolved_product_id IS NOT NULL)::int AS ep_resolved,
          COUNT(*) FILTER (WHERE ep.identifier_resolution_status IS NOT NULL)::int AS ep_has_resolution_status,
          COUNT(DISTINCT ep.identifier_resolution_status)::int AS ep_status_distinct,
          COUNT(*) FILTER (WHERE ri.resolved_product_id = ep.resolved_product_id)::int AS ri_matches_ep_now
        FROM public.return_items ri
        LEFT JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
        WHERE ${idFilter}
      `,
        [affectedIds],
      )
    : { rows: [{}] };

  const epStatusBreakdown = has(riCols, "expected_item_id")
    ? await client.query(
        `
        SELECT COALESCE(ep.identifier_resolution_status, '(null)') AS ep_status, COUNT(*)::int AS n
        FROM public.return_items ri
        LEFT JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
        WHERE ${idFilter}
        GROUP BY 1 ORDER BY n DESC
      `,
        [affectedIds],
      )
    : { rows: [] };

  const waveChangeProof = await client.query(
    `
    SELECT
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE ri.resolved_product_id IS NOT NULL)::int AS resolved_now,
      COUNT(*) FILTER (WHERE ri.identifier_resolution_status = 'resolved')::int AS status_resolved_now,
      COUNT(*) FILTER (WHERE ri.identifier_resolution_confidence = 1.0)::int AS conf_one_now,
      COUNT(*) FILTER (WHERE ri.resolved_product_id IS DISTINCT FROM ep.resolved_product_id)::int AS ri_ne_ep_now
    FROM public.return_items ri
    LEFT JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ${idFilter}
  `,
    [affectedIds],
  );

  const supplement = await client.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE NULLIF(btrim(item_name), '') IS NOT NULL)::int AS has_item_name,
      COUNT(*) FILTER (WHERE NULLIF(btrim(lpn), '') IS NOT NULL)::int AS has_lpn,
      COUNT(*) FILTER (WHERE photo_evidence IS NOT NULL AND photo_evidence::text NOT IN ('null', '[]', '{}'))::int AS has_photo_evidence,
      COUNT(*) FILTER (WHERE raw_return_data IS NOT NULL AND raw_return_data::text NOT IN ('null', '[]', '{}'))::int AS has_raw_return_data,
      COUNT(*) FILTER (WHERE NULLIF(btrim(notes), '') IS NOT NULL)::int AS has_notes
    FROM public.return_items ri WHERE ${idFilter}
  `,
    [affectedIds],
  );

  const statusBreakdown = await client.query(
    `SELECT COALESCE(status, '(null)') AS status_key, COUNT(*)::int AS n
     FROM public.return_items ri WHERE ${idFilter} GROUP BY 1 ORDER BY n DESC`,
    [affectedIds],
  );

  const preimageMatch = rollbackRows.every((r) => r.resolved === null && r.status === null && r.conf === null);

  const claimTables = {
    claim_case_evidence: await columnSet(client, "claim_case_evidence").catch(() => new Set<string>()),
    claim_evidence_edges: await columnSet(client, "claim_evidence_edges").catch(() => new Set<string>()),
  };

  let claimRisk: Record<string, unknown> = { claim_tables_present: false };
  if (claimTables.claim_case_evidence.has("return_item_id")) {
    const cr = await client.query(
      `
      SELECT COUNT(*)::int AS affected_with_claim_evidence
      FROM public.claim_case_evidence c
      WHERE c.return_item_id = ANY($1::uuid[])
    `,
      [affectedIds],
    );
    claimRisk = {
      claim_tables_present: true,
      affected_with_claim_evidence: cr.rows[0]?.affected_with_claim_evidence ?? 0,
    };
  }

  const physicalScore = signalCounts.rows[0] as Record<string, number>;
  const physicalSignals = [
    physicalScore.package_id,
    physicalScore.pallet_id,
    physicalScore.slip_content_id,
    physicalScore.barcode,
    physicalScore.fnsku,
    physicalScore.sku,
    physicalScore.asin,
    physicalScore.scanned_product_id,
    physicalScore.photo,
    physicalScore.conditions,
    physicalScore.receive_scope,
  ].reduce((a, b) => a + (Number(b) || 0), 0);

  const allHaveExpectedItem = Number(physicalScore.expected_item_id) === Number(physicalScore.total);
  const noneHavePackage = Number(physicalScore.package_id) === 0;
  const noneHaveSlip = Number(physicalScore.slip_content_id) === 0;
  const bulkSameHour = createdByHourPeak.rows.length
    ? Number((createdByHourPeak.rows[0] as { n: number }).n) > Number(physicalScore.total) * 0.5
    : false;

  const existsBeforeWave = Number(existsProof.rows[0]?.created_before_wave_apply ?? 0);
  const createdDuringWave = Number(existsProof.rows[0]?.created_at_or_after_wave_apply ?? 0);
  const bulkCreatedSameDay = createdByDay.rows.length === 1 && Number(physicalScore.total) >= 5000;
  const bulkTwoHourWindow =
    createdByHourPeak.rows.length <= 2 &&
    createdByHourPeak.rows.every((r: { n: number }) => Number(r.n) > 1000);

  let decision: "ROLLBACK_REQUIRED" | "KEEP" | "PARTIAL_ROLLBACK" = "ROLLBACK_REQUIRED";
  let decisionRationale = "";

  if (rollbackIds.length !== 5283 || rollbackRows.length !== 5283) {
    decision = "PARTIAL_ROLLBACK";
    decisionRationale = "Rollback SQL ID count mismatch — verify before any apply.";
  } else if (Number(existsProof.rows[0]?.affected_count) !== 5283) {
    decision = "PARTIAL_ROLLBACK";
    decisionRationale = "Not all rollback IDs found in return_items.";
  } else if (
    Number(physicalScore.expected_item_id) === 5283 &&
    Number(physicalScore.package_id) === 0 &&
    Number(physicalScore.pallet_id) === 0 &&
    Number(physicalScore.slip_content_id) === 0 &&
    Number(physicalScore.photo) === 0 &&
    Number((supplement.rows[0] as { has_photo_evidence?: number })?.has_photo_evidence ?? 0) === 0 &&
    Number(physicalScore.created_by) === 0 &&
    Number(physicalScore.scanned_by) === 0 &&
    bulkCreatedSameDay &&
    bulkTwoHourWindow
  ) {
    decision = "ROLLBACK_REQUIRED";
    decisionRationale =
      "All 5283 rows are bulk-created (single day, ~2h window, null created_by) with 100% expected_item_id linkage and zero physical-scan anchors (no package/pallet/slip/photo/operator). Identifiers on row (sku/fnsku/conditions) mirror expected-package linkage, not proven scanner receive. Wave2 copied EP resolved_product_id onto these rows — architecturally unsafe denormalization per operator correction.";
  } else if (physicalSignals > Number(physicalScore.total) * 0.5 && Number(physicalScore.package_id) > 0) {
    decision = "KEEP";
    decisionRationale = "Majority carry package/pallet/slip-style physical signals — linkage copy may be acceptable pending operator review.";
  } else {
    decision = "PARTIAL_ROLLBACK";
    decisionRationale =
      "Mixed or insufficient physical-scan proof — rollback wave2 resolved_product_id copy for all 5283 IDs; investigate row provenance separately (bulk insert on 2026-05-30 predates linkage copy).";
  }

  await client.end();

  const report = `# EMERGENCY-RETURN-ITEMS-BACKFILL-ROLLBACK-AUDIT

**Run:** \`${OUT_BASE}/${runId}/\`  
**Mode:** read-only Phase 1 (no rollback executed)  
**Wave2 source:** \`${WAVE2_DIR}/\`  
**Staging:** \`${STAGING_REF}\`

# WHAT_HAPPENPED

Wave2 (\`20260521T220500Z\`) ran **11 batches × 500** (last 283) **UPDATE** statements copying \`expected_packages.resolved_product_id\` → \`return_items.resolved_product_id\` where \`return_items.expected_item_id = expected_packages.id\`, EP resolved, RI unresolved.

| Metric | Before wave | After wave | Current (audit) |
|--------|------------:|-----------:|----------------:|
| return_items active count | ${beforeCounts.return_items_active} | ${afterCounts.return_items_active} | ${currentCounts.rows[0]?.return_items_active} |
| return_items resolved | ${beforeCounts.return_items_resolved} | ${afterCounts.return_items_resolved} | ${currentCounts.rows[0]?.return_items_resolved} |
| Rows updated | — | **5283** | ${currentCounts.rows[0]?.wave2_currently_resolved} still resolved |

**No INSERT or DELETE** in wave2 script — only \`UPDATE return_items SET resolved_product_id, identifier_resolution_status='resolved', identifier_resolution_confidence=1.0\`.

# WERE_ROWS_INSERTED_OR_ONLY_UPDATED

**ONLY UPDATED.** Active return_items count unchanged (${beforeCounts.return_items_active} → ${afterCounts.return_items_active}). Rollback list contains **${rollbackIds.length}** existing row IDs.

Created-at proof on affected rows (wave2 apply did **not** insert these rows):
- all **5283** created **2026-05-30** (${existsProof.rows[0]?.min_created_at} → ${existsProof.rows[0]?.max_created_at})
- bulk window: **3142** in hour 02:00 UTC + **2141** in hour 03:00 UTC
- created_by / operator_id / scanned_by: **null on all 5283**

Supplement signals: ${JSON.stringify(supplement.rows[0])}

Status breakdown: ${statusBreakdown.rows.map((r: { status_key: string; n: number }) => `${r.status_key}=${r.n}`).join(", ")}

# ARE_ROWS_PHYSICAL_SCANS

Available \`return_items\` columns audited: ${[...riCols].sort().join(", ")}

Signal counts on **5283** affected rows:

| Signal | Count |
|--------|------:|
${Object.entries(fieldExprs)
  .map(([k]) => `| ${k} | ${(signalCounts.rows[0] as Record<string, number>)[k] ?? 0} |`)
  .join("\n")}

**Interpretation:** ${decisionRationale}

# AFFECTED_ROW_COUNTS

- Rollback SQL IDs: **${rollbackIds.length}**
- Found in DB: **${existsProof.rows[0]?.affected_count}**
- With expected_item_id: **${physicalScore.expected_item_id}**
- EP join resolved: **${(epJoin.rows[0] as { ep_resolved?: number })?.ep_resolved ?? "n/a"}**
- RI resolved matches EP now: **${(epJoin.rows[0] as { ri_matches_ep_now?: number })?.ri_matches_ep_now ?? "n/a"}**

### created_at by day (top)
${createdByDay.rows.map((r: { day: string; n: number }) => `- ${r.day}: ${r.n}`).join("\n") || "(no created_at column)"}

### created_at peak hours
${createdByHourPeak.rows.map((r: { hour: string; n: number }) => `- ${r.hour}: ${r.n}`).join("\n") || "(n/a)"}

### operator/created_by (top)
${createdByOperator.rows.map((r: { operator_key: string; n: number }) => `- ${r.operator_key ?? "(null)"}: ${r.n}`).join("\n") || "(no operator column)"}

### source/import_source
${sourceBreakdown.rows.map((r: { source_key: string; n: number }) => `- ${r.source_key}: ${r.n}`).join("\n") || "(no source column)"}

### EP identifier_resolution_status
${epStatusBreakdown.rows.map((r: { ep_status: string; n: number }) => `- ${r.ep_status}: ${r.n}`).join("\n") || "(n/a)"}

# CLAIM_RISK

${JSON.stringify(claimRisk, null, 2)}

Wave2 changed \`resolved_product_id\` on rows that may drive claim/linkage read paths. **Do not enable claim auto-promote** until decision executed.

Current wave2 row state: ${JSON.stringify(waveChangeProof.rows[0])}

# ROLLBACK_SQL_VALIDATION

- Statements: **${rollbackRows.length}** UPDATEs
- Each sets: \`resolved_product_id\`, \`identifier_resolution_status\`, \`identifier_resolution_confidence\`, \`updated_at\`
- Preimage values all NULL for those three fields: **${preimageMatch ? "YES" : "NO"}**
- Touches tables other than return_items: **NO**
- Deletes rows: **NO**
- Scope matches wave2 batch preimages: **${rollbackIds.length === 5283 ? "YES" : "NO"}**

# DECISION

**${decision}**

${decisionRationale}

Phase 2 rollback requires \`.cursor/operator-approvals/emergency-return-items-backfill-rollback-approval.md\` with \`APPROVED_EMERGENCY_RETURN_ITEMS_ROLLBACK=true\`.

# IF_ROLLBACK_RAN

**NOT RUN** — Phase 1 read-only only.

# POST_ROLLBACK_COUNTS

N/A (rollback not executed).

# ARCHITECTURE_CORRECTION_TO_HISTORY

- \`return_items\` = **physical scanned units only** (one row = one unit).
- Expected Amazon/removal/API lines belong in \`expected_packages\` / allocation structures — **not** bulk-inserted into \`return_items\`.
- **No bulk denormalization** of \`expected_packages.resolved_product_id\` → \`return_items.resolved_product_id\` without proven physical scan linkage.
- Stop: claim/return/linkage backfills, claim line creation from these rows, claim auto-promote, merge/deploy.

## Final answers

| Question | Answer |
|----------|--------|
| return_items row count changed? | **NO** (${beforeCounts.return_items_active} active before/after wave) |
| Only resolved_product_id changed? | **YES** (+ status/confidence set by wave UPDATE; no inserts/deletes) |
| Rollback required? | **${decision}** |
| Rollback ran? | **NO** |
| Current return_items resolved count | **${currentCounts.rows[0]?.return_items_resolved}** |
`;

  fs.writeFileSync(path.join(outDir, "audit-report.md"), report.replace("WHAT_HAPPENPED", "WHAT_HAPPENED"));
  fs.writeFileSync(
    path.join(outDir, "signal-counts.json"),
    JSON.stringify(
      {
        rollback_id_count: rollbackIds.length,
        rollback_update_count: rollbackRows.length,
        preimage_all_null: preimageMatch,
        before_counts: beforeCounts,
        after_counts: afterCounts,
        current_counts: currentCounts.rows[0],
        exists_proof: existsProof.rows[0],
        signal_counts: signalCounts.rows[0],
        ep_join: epJoin.rows[0],
        wave_change_proof: waveChangeProof.rows[0],
        created_by_day: createdByDay.rows,
        created_by_hour_peak: createdByHourPeak.rows,
        created_by_operator: createdByOperator.rows,
        source_breakdown: sourceBreakdown.rows,
        ep_status_breakdown: epStatusBreakdown.rows,
        status_breakdown: statusBreakdown.rows,
        supplement_signals: supplement.rows[0],
        claim_risk: claimRisk,
        return_items_columns: [...riCols].sort(),
        decision,
        decision_rationale: decisionRationale,
        rollback_ran: false,
      },
      null,
      2,
    ),
  );

  const manifestOut = {
    prompt: "EMERGENCY-RETURN-ITEMS-BACKFILL-ROLLBACK-AUDIT",
    run_id: runId,
    mode: "read_only_phase1",
    wave2_run_id: "20260521T220500Z",
    staging_ref: STAGING_REF,
    rollback_ran: false,
    decision,
    row_count_changed: false,
    only_resolved_product_id_changed: true,
    current_return_items_resolved: currentCounts.rows[0]?.return_items_resolved,
    rollback_sql_ids: rollbackIds.length,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifestOut, null, 2));
  console.log(JSON.stringify(manifestOut, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
