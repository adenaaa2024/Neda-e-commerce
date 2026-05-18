/**
 * NEXT-PRODUCT-ID-17C — Wave 1b scoped UPDATE (transactional).
 * Reads wave-1b-eligible-pks.csv + validates preimage; no APIs, no PIM mutations.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function loadDirectPostgresUrl() {
  const p = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(p)) throw new Error("Missing .env.local");
  const line = fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DIRECT_POSTGRES_URL="));
  if (!line) throw new Error("DIRECT_POSTGRES_URL not set in .env.local");
  return line.slice("DIRECT_POSTGRES_URL=".length).trim();
}

function parseCsvRows(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trimEnd();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",");
    const obj = {};
    header.forEach((h, j) => {
      obj[h] = cols[j] ?? "";
    });
    rows.push(obj);
  }
  return { header, rows };
}

function runIdUtc() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const ELIGIBLE = path.join(
  REPO_ROOT,
  ".cursor/audit-reports/next-product-id-17/20260514T020926Z/wave-1b-eligible-pks.csv",
);
const PREIMAGE = path.join(
  REPO_ROOT,
  ".cursor/audit-reports/next-product-id-17b/20260514T023225Z/wave-1b-preimage-export.csv",
);
const OUT_BASE = path.join(REPO_ROOT, ".cursor/audit-reports/next-product-id-17c");

const logs = [];

function log(event, data = {}) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  logs.push(JSON.stringify(rec));
  console.log(JSON.stringify(rec));
}

async function main() {
  const runId = runIdUtc();
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });

  log("start", { runId, auditPrompt: "NEXT-PRODUCT-ID-17C" });

  const url = loadDirectPostgresUrl();
  log("precheck_env", { directPostgresUrlPresent: true });

  const { rows: eligibleRows } = parseCsvRows(ELIGIBLE);
  const { rows: preimageRows } = parseCsvRows(PREIMAGE);

  if (eligibleRows.length !== 144) throw new Error(`eligible rows expected 144 got ${eligibleRows.length}`);
  if (preimageRows.length !== 144) throw new Error(`preimage rows expected 144 got ${preimageRows.length}`);

  for (const r of eligibleRows) {
    if (r.wave !== "1b") throw new Error(`non-1b wave: ${r.source_row_id} wave=${r.wave}`);
  }

  const eligIds = new Set(eligibleRows.map((r) => r.source_row_id));
  const preIds = new Set(preimageRows.map((r) => r.id));
  if (eligIds.size !== 144 || preIds.size !== 144) throw new Error("duplicate ids in csv");
  for (const id of eligIds) {
    if (!preIds.has(id)) throw new Error(`preimage missing id ${id}`);
  }

  log("precheck_csv", { eligible: 144, preimage: 144, idSetsMatch: true });

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  log("db_connected", {});

  let committed = false;
  let updateCount = -1;
  let preResolved = 0;
  let preUnresolved = 0;
  let postResolved = 0;
  let postUnresolved = 0;
  let wave1bResolvedAfter = 0;
  let preNullStrict = 0;
  let productHitOk = 0;

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");

    await client.query(`
      CREATE TEMP TABLE wave_1b_staging (
        source_row_id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        resolved_product_id uuid NOT NULL,
        resolved_catalog_product_id uuid,
        identifier_resolution_confidence numeric(10,4) NOT NULL DEFAULT 0.95
      ) ON COMMIT DROP;
    `);

    for (const r of eligibleRows) {
      await client.query(
        `INSERT INTO wave_1b_staging (source_row_id, organization_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_confidence)
         VALUES ($1::uuid, $2::uuid, $3::uuid, NULL::uuid, 0.95::numeric)`,
        [r.source_row_id, r.organization_id, r.existing_product_id_hit],
      );
    }

    const { rows: phNull } = await client.query(`
      SELECT COUNT(*)::int AS c
      FROM public.amazon_fba_inventory afi
      INNER JOIN wave_1b_staging s ON s.source_row_id = afi.id AND s.organization_id = afi.organization_id
      WHERE afi.resolved_product_id IS NULL
        AND afi.resolved_catalog_product_id IS NULL
        AND afi.identifier_resolution_status IS NULL
        AND afi.identifier_resolution_confidence IS NULL
    `);
    preNullStrict = phNull[0].c;
    log("precheck_resolver_null_strict", { count: preNullStrict });
    if (preNullStrict !== 144) {
      await client.query("ROLLBACK");
      log("rollback", { reason: "preNullStrict !== 144", preNullStrict });
      throw new Error(`ROLLBACK: strict null preimage count ${preNullStrict} expected 144`);
    }

    const { rows: pHit } = await client.query(`
      SELECT COUNT(*)::int AS c
      FROM wave_1b_staging s
      INNER JOIN public.products p ON p.id = s.resolved_product_id
    `);
    productHitOk = pHit[0].c;
    log("precheck_product_exists", { stagingRowsWithProduct: productHitOk });
    if (productHitOk !== 144) {
      await client.query("ROLLBACK");
      log("rollback", { reason: "product fk check failed", productHitOk });
      throw new Error(`ROLLBACK: products join count ${productHitOk}`);
    }

    const { rows: preR } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
      FROM public.amazon_fba_inventory
    `);
    preResolved = preR[0].resolved;
    preUnresolved = preR[0].unresolved;
    log("precheck_totals", { preResolved, preUnresolved });

    const upd = await client.query(`
      UPDATE public.amazon_fba_inventory AS afi
      SET
        resolved_product_id = s.resolved_product_id,
        resolved_catalog_product_id = s.resolved_catalog_product_id,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = s.identifier_resolution_confidence,
        updated_at = now()
      FROM wave_1b_staging AS s
      WHERE afi.id = s.source_row_id
        AND afi.organization_id = s.organization_id
        AND afi.resolved_product_id IS NULL
    `);
    updateCount = upd.rowCount;
    log("update_executed", { rowCount: updateCount });

    if (updateCount !== 144) {
      await client.query("ROLLBACK");
      log("rollback", { reason: "update row count", updateCount });
      throw new Error(`ROLLBACK: UPDATE affected ${updateCount} expected 144`);
    }

    const { rows: postR } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
      FROM public.amazon_fba_inventory
    `);
    postResolved = postR[0].resolved;
    postUnresolved = postR[0].unresolved;
    log("postcheck_totals", { postResolved, postUnresolved });

    const { rows: w1b } = await client.query(`
      SELECT COUNT(*)::int AS c
      FROM public.amazon_fba_inventory afi
      INNER JOIN wave_1b_staging s ON s.source_row_id = afi.id AND s.organization_id = afi.organization_id
      WHERE afi.resolved_product_id IS NOT NULL
        AND afi.identifier_resolution_status = 'resolved'
    `);
    wave1bResolvedAfter = w1b[0].c;

    const { rows: badPair } = await client.query(`
      SELECT COUNT(*)::int AS c
      FROM public.amazon_fba_inventory afi
      INNER JOIN wave_1b_staging s ON s.source_row_id = afi.id
      WHERE afi.resolved_product_id IS DISTINCT FROM s.resolved_product_id
    `);
    if (badPair[0].c !== 0) {
      await client.query("ROLLBACK");
      log("rollback", { reason: "afi product mismatch staging", badPair: badPair[0].c });
      throw new Error("ROLLBACK: resolved_product_id mismatch vs staging");
    }

    if (postResolved !== 782 || postUnresolved !== 167 || wave1bResolvedAfter !== 144) {
      await client.query("ROLLBACK");
      log("rollback", {
        reason: "post counts",
        postResolved,
        postUnresolved,
        wave1bResolvedAfter,
      });
      throw new Error(
        `ROLLBACK: postResolved=${postResolved} (want 782) postUnresolved=${postUnresolved} (want 167) wave1b=${wave1bResolvedAfter} (want 144)`,
      );
    }

    await client.query("COMMIT");
    committed = true;
    log("commit", { ok: true });
  } catch (e) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    throw e;
  } finally {
    await client.end();
  }

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-17C",
    runId,
    wave: "1b",
    inputs: {
      nextProductId17b: ".cursor/audit-reports/next-product-id-17b/20260514T023225Z/",
      nextProductId17: ".cursor/audit-reports/next-product-id-17/20260514T020926Z/",
    },
    updateRowCount: updateCount,
    postVerify: {
      totalResolvedResolvedStatus: postResolved,
      totalUnresolvedNullProduct: postUnresolved,
      wave1bRowsResolved: wave1bResolvedAfter,
    },
    preTransactionSnapshot: { resolved: preResolved, unresolved: preUnresolved },
    validation: {
      noProductCreates: true,
      noProductIdentifierMapMutation: true,
      noAmazonApi: true,
      noOpenAi: true,
      noMigrations: true,
      committed,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "logs", "product-id-17c.ndjson"), logs.join("\n") + "\n", "utf8");

  const summary = `# execution-summary — NEXT-PRODUCT-ID-17C

**Run ID:** \`${runId}\`

## What ran

Single PostgreSQL transaction:

1. \`CREATE TEMP TABLE wave_1b_staging\` loaded from \`wave-1b-eligible-pks.csv\` (144 rows).
2. Pre-checks: strict-null resolver fields on all 144 PKs; \`existing_product_id_hit\` exists in \`public.products\`.
3. \`UPDATE public.amazon_fba_inventory\` … \`FROM wave_1b_staging\` with \`afi.resolved_product_id IS NULL\` and org join.
4. Post-checks: row counts and staging vs \`afi.resolved_product_id\` equality.

## Result

- **Committed:** ${committed}
- **Rows updated:** ${updateCount}
- **Total resolved** (\`resolved_product_id IS NOT NULL\` AND \`identifier_resolution_status = 'resolved'\`): **${postResolved}**
- **Unresolved** (\`resolved_product_id IS NULL\`): **${postUnresolved}**
- **Wave 1b rows in resolved state (scoped join):** **${wave1bResolvedAfter}**

## Constraints

- No \`INSERT\` into \`products\`; no \`product_identifier_map\` writes; no migrations; no HTTP to Amazon or OpenAI.
`;

  fs.writeFileSync(path.join(outDir, "execution-summary.md"), summary, "utf8");

  fs.writeFileSync(
    path.join(outDir, "update-row-count-check.md"),
    `# update-row-count-check\n\n| Check | Value |\n|------|------:|\n| Expected UPDATE rows | 144 |\n| Actual \`UPDATE\` \`rowCount\` | **${updateCount}** |\n| Transaction | ${committed ? "COMMIT" : "ROLLBACK"} |\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "post-update-verify.md"),
    `# post-update-verify\n\n| Metric | Expected | Actual |\n|--------|----------|--------|\n| Wave 1b resolved (join staging) | 144 | **${wave1bResolvedAfter}** |\n| Total resolved (status + product) | 782 | **${postResolved}** |\n| Unresolved (null product) | 167 | **${postUnresolved}** |\n| Pre resolved (before) | — | ${preResolved} |\n| Pre unresolved (before) | — | ${preUnresolved} |\n| Strict-null preimage rows | 144 | **${preNullStrict}** |\n| Staging → products FK | 144 | **${productHitOk}** |\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "no-extra-row-confirmation.md"),
    `# no-extra-row-confirmation\n\n- Staging table contained **exactly 144** PKs from \`wave-1b-eligible-pks.csv\` (all \`wave=1b\`).\n- \`UPDATE\` predicate included \`afi.id = s.source_row_id\` AND \`afi.organization_id = s.organization_id\` AND \`afi.resolved_product_id IS NULL\` — no broad scan.\n- **Wave 1a** PKs are not in this CSV (NEXT-PRODUCT-ID-17B overlap 0); they were not in staging and were not updated.\n- Post-check: zero rows where \`afi.resolved_product_id\` differs from staging \`resolved_product_id\` for Wave 1b ids.\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-readiness.md"),
    `# rollback-readiness\n\n- Any failed count check issued **ROLLBACK** before COMMIT (see \`logs/product-id-17c.ndjson\`).\n- Successful run **COMMIT**ted; to reverse manually, restore resolver columns for the 144 PKs from \`wave-1b-preimage-export.csv\` (all were null before run) via a scoped UPDATE using that CSV as source of truth for prior nulls.\n`,
    "utf8",
  );

  log("artifacts_written", { outDir });
  console.log(`\nOK — ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
