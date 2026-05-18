/**
 * NEXT-PRODUCTION-READINESS-02 — read-only production probe.
 * Run only when production-readiness-01-approval.md has ref + flags + connection in .env.local.
 *
 *   npx tsx scripts/next-production-readiness-02-probe.ts --run-id=20260518T120000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const STAGING_REF = "kxsvedvpjldygtdbylsy";
const APPROVAL_PATH = path.join(
  process.cwd(),
  ".cursor/operator-approvals/production-readiness-01-approval.md",
);

const RESOLVER_17_TABLES = [
  "shipment_containers",
  "shipment_boxes",
  "shipment_box_items",
  "removal_item_allocations",
  "claim_review_work_items",
  "claim_filing_requests",
];

const RESOLVER_17_FUNCTIONS = [
  "rebuild_shipment_tree_from_removal_shipments",
  "rebuild_removal_item_allocations",
  "enrich_expected_packages_from_shipment_allocations",
  "backfill_expected_packages_shipment_meta",
];

const FINANCES_TABLES = [
  "amazon_finances_source_runs",
  "amazon_finances_api_pages",
  "amazon_finances_event_groups",
  "amazon_finances_events",
];

const CCE_TABLES = [
  "claim_enrichment_generations",
  "claim_evidence_lineage_events",
  "claim_reference_edges",
  "claim_enrichment_freeze_state",
];

const ROW_COUNT_TABLES = [
  "organizations",
  "products",
  "financial_reference_resolver",
  "return_items",
  "amazon_finances_events",
];

type GateResult = { id: string; pass: boolean; detail: string };

function loadEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

function refFromConnectionString(url: string): string | null {
  const m =
    url.match(/postgres\.([a-z]{20}):/i) ||
    url.match(/@db\.([a-z]{20})\.supabase\.co/i) ||
    url.match(/([a-z]{20})\.supabase\.co/i);
  return m ? m[1]!.toLowerCase() : null;
}

function parseApproval(content: string): {
  registerFlag: boolean;
  probeFlag: boolean;
  refFromFile: string | null;
} {
  const registerFlag = /^APPROVED_TO_REGISTER_PRODUCTION_REF\s*=\s*true\s*$/im.test(content);
  const probeFlag = /^APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE\s*=\s*true\s*$/im.test(content);
  let refFromFile: string | null = null;
  const refLine = content.match(/^Production project ref:\s*([a-z]{20})\s*$/im);
  if (refLine) refFromFile = refLine[1]!.toLowerCase();
  const inline = content.match(/PRODUCTION_PROJECT_REF\s*=\s*([a-z]{20})/i);
  if (!refFromFile && inline) refFromFile = inline[1]!.toLowerCase();
  if (refFromFile?.includes("fill_production")) refFromFile = null;
  return { registerFlag, probeFlag, refFromFile };
}

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function preflight(
  env: Record<string, string>,
  approvalContent: string,
): { ok: boolean; gates: GateResult[]; connectionUrl: string | null; productionRef: string | null } {
  const gates: GateResult[] = [];
  const { registerFlag, probeFlag, refFromFile } = parseApproval(approvalContent);

  gates.push({
    id: "approval_register_flag",
    pass: registerFlag,
    detail: registerFlag
      ? "APPROVED_TO_REGISTER_PRODUCTION_REF=true"
      : "APPROVED_TO_REGISTER_PRODUCTION_REF not true",
  });
  gates.push({
    id: "approval_probe_flag",
    pass: probeFlag,
    detail: probeFlag
      ? "APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE=true"
      : "APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE not true",
  });

  const connectionUrl =
    env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() ||
    env.RESOLVER_19B_PRODUCTION_DIRECT_POSTGRES_URL?.trim() ||
    null;

  const productionRef =
    env.PRODUCTION_PROJECT_REF?.trim().toLowerCase() ||
    refFromFile ||
    (connectionUrl ? refFromConnectionString(connectionUrl) : null);

  const refValid =
    !!productionRef &&
    productionRef.length === 20 &&
    productionRef !== STAGING_REF &&
    !productionRef.includes("fill");

  gates.push({
    id: "production_ref_present",
    pass: refValid,
    detail: refValid
      ? `ref=${productionRef}`
      : productionRef === STAGING_REF
        ? "ref equals staging dev ref — refused"
        : "production ref missing in approval signoff and env",
  });

  gates.push({
    id: "read_only_connection",
    pass: !!connectionUrl,
    detail: connectionUrl
      ? "PRODUCTION_DIRECT_POSTGRES_URL present (value not logged)"
      : "PRODUCTION_DIRECT_POSTGRES_URL unset",
  });

  if (connectionUrl && productionRef) {
    const refInUrl = refFromConnectionString(connectionUrl);
    gates.push({
      id: "connection_ref_match",
      pass: refInUrl === productionRef,
      detail:
        refInUrl === productionRef
          ? "connection host ref matches registered production ref"
          : `connection ref ${refInUrl ?? "?"} != registered ${productionRef}`,
    });
  }

  const ok = gates.every((g) => g.pass);
  return { ok, gates, connectionUrl, productionRef: refValid ? productionRef! : null };
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return r.rowCount !== null && r.rowCount > 0;
}

async function columnsPresent(
  c: pg.Client,
  table: string,
  columns: string[],
): Promise<{ present: string[]; missing: string[] }> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, columns],
  );
  const present = new Set(r.rows.map((row) => row.column_name as string));
  return {
    present: columns.filter((col) => present.has(col)),
    missing: columns.filter((col) => !present.has(col)),
  };
}

async function functionExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1
     LIMIT 1`,
    [name],
  );
  return r.rowCount !== null && r.rowCount > 0;
}

async function rlsEnabled(c: pg.Client, table: string): Promise<boolean | null> {
  try {
    const r = await c.query(
      `SELECT c.relrowsecurity AS rls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    if (!r.rows[0]) return null;
    return Boolean(r.rows[0].rls);
  } catch {
    return null;
  }
}

async function runProbe(connectionUrl: string, productionRef: string) {
  const client = new pg.Client({ connectionString: connectionUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const session = await client.query(`SELECT 1 AS ok, current_user, session_user`);
  const migrations = await client.query(
    `SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version`,
  ).catch(async () => {
    const fallback = await client.query(
      `SELECT name AS version, name FROM supabase_migrations.schema_migrations ORDER BY name`,
    );
    return fallback;
  });

  const repoMigrations = fs
    .readdirSync(path.join(process.cwd(), "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();

  const appliedVersions = new Set(
    migrations.rows.map((r) => String(r.version ?? r.name).replace(/\.sql$/, "")),
  );
  const repoNotApplied = repoMigrations.filter((v) => !appliedVersions.has(v));

  const resolverTables: Record<string, boolean> = {};
  for (const t of RESOLVER_17_TABLES) resolverTables[t] = await tableExists(client, t);

  const resolverFns: Record<string, boolean> = {};
  for (const f of RESOLVER_17_FUNCTIONS) resolverFns[f] = await functionExists(client, f);

  const financesTables: Record<string, boolean> = {};
  for (const t of FINANCES_TABLES) financesTables[t] = await tableExists(client, t);

  const cceTables: Record<string, boolean> = {};
  for (const t of CCE_TABLES) cceTables[t] = await tableExists(client, t);

  const productCols = await columnsPresent(client, "products", ["name", "product_name"]);
  const afiCols = await columnsPresent(client, "amazon_amazon_fulfilled_inventory", [
    "product_id",
    "resolved_product_id",
    "resolved_catalog_product_id",
    "identifier_resolution_status",
    "identifier_resolution_confidence",
  ]);
  const fbaCols = await columnsPresent(client, "amazon_fba_inventory", [
    "product_id",
    "resolved_product_id",
    "resolved_catalog_product_id",
    "identifier_resolution_status",
    "identifier_resolution_confidence",
  ]);
  const returnItemCols = await columnsPresent(client, "return_items", [
    "resolved_product_id",
    "identifier_resolution_status",
    "resolved_catalog_product_id",
    "identifier_resolution_confidence",
  ]);
  const slipCols = await columnsPresent(client, "slip_contents", [
    "identifier_resolution_status",
    "resolved_product_id",
  ]);
  const allocCol = await columnsPresent(client, "expected_packages", ["allocation_box_code"]);

  const rowCounts: Record<string, number | null> = {};
  for (const t of ROW_COUNT_TABLES) {
    if (!(await tableExists(client, t))) {
      rowCounts[t] = null;
      continue;
    }
    try {
      const c = await client.query(`SELECT COUNT(*)::bigint AS n FROM public."${t}"`);
      rowCounts[t] = Number(c.rows[0].n);
    } catch {
      rowCounts[t] = null;
    }
  }

  const rlsSample: Record<string, boolean | null> = {};
  for (const t of [
    "return_items",
    "amazon_finances_source_runs",
    "claim_enrichment_generations",
    "financial_reference_resolver",
  ]) {
    rlsSample[t] = (await tableExists(client, t)) ? await rlsEnabled(client, t) : null;
  }

  await client.end();

  const resolver17Green =
    RESOLVER_17_TABLES.every((t) => resolverTables[t]) &&
    RESOLVER_17_FUNCTIONS.every((f) => resolverFns[f]) &&
    allocCol.missing.length === 0;

  const financesGreen = FINANCES_TABLES.every((t) => financesTables[t]);
  const cceGreen = CCE_TABLES.every((t) => cceTables[t]);
  const scannerGreen =
    returnItemCols.missing.length === 0 && slipCols.missing.length === 0;
  const productGreen =
    productCols.present.includes("product_name") || productCols.present.includes("name");
  const fbaGreen = fbaCols.missing.length === 0;
  const afiGreen = afiCols.missing.length === 0;

  return {
    probed_at: new Date().toISOString(),
    production_project_ref: productionRef,
    session: session.rows[0],
    migrations: {
      applied_count: migrations.rows.length,
      latest_version:
        migrations.rows.length > 0
          ? String(migrations.rows[migrations.rows.length - 1].version)
          : null,
      repo_file_count: repoMigrations.length,
      repo_versions_not_on_production_sample: repoNotApplied.slice(-25),
      repo_versions_not_on_production_count: repoNotApplied.length,
    },
    parity: {
      resolver_17: { green: resolver17Green, tables: resolverTables, functions: resolverFns, allocation_box_code: allocCol },
      product_identity: { green: productGreen && afiGreen && fbaGreen, products: productCols, afi: afiCols, fba: fbaCols },
      scanner_returns: { green: scannerGreen, return_items: returnItemCols, slip_contents: slipCols },
      finances_archive: { green: financesGreen, tables: financesTables },
      cce_04: { green: cceGreen, tables: cceTables },
    },
    row_count_estimates: rowCounts,
    rls_sample: rlsSample,
    overall_parity_green:
      resolver17Green && financesGreen && cceGreen && scannerGreen && productGreen,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/next-production-readiness-02",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(APPROVAL_PATH)) {
    console.error(`Missing approval file: ${APPROVAL_PATH}`);
    process.exit(1);
  }

  const approvalContent = fs.readFileSync(APPROVAL_PATH, "utf8");
  const env = loadEnvLocal();
  const pre = preflight(env, approvalContent);

  const payload: Record<string, unknown> = {
    prompt: "NEXT-PRODUCTION-READINESS-02",
    run_id: runId,
    staging_reference_ref: STAGING_REF,
    preflight_gates: pre.gates,
    production_probe: { ran: false, reason: null as string | null },
  };

  if (!pre.ok) {
    payload.production_probe = {
      ran: false,
      reason: "preflight_failed",
      failed_gates: pre.gates.filter((g) => !g.pass).map((g) => g.id),
    };
    fs.writeFileSync(path.join(outDir, "preflight-gates.json"), JSON.stringify(pre.gates, null, 2));
    fs.writeFileSync(path.join(outDir, "probe-results.json"), JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    process.exit(2);
  }

  const results = await runProbe(pre.connectionUrl!, pre.productionRef!);
  payload.production_probe = { ran: true, ...results };
  fs.writeFileSync(path.join(outDir, "probe-results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "production-migrations-applied.json"),
    JSON.stringify(results.migrations, null, 2),
  );
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
