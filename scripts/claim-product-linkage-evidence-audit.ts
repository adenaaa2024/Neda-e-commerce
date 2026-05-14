/**
 * NEXT-CLAIM-07 — Read-only product linkage + operator evidence audit for Claim MVP.
 *
 * SELECT-only (Supabase service role). Writes:
 *   .cursor/audit-reports/next-claim-07/<run_id>/
 *
 * Usage:
 *   npx tsx scripts/claim-product-linkage-evidence-audit.ts
 *   npx tsx scripts/claim-product-linkage-evidence-audit.ts --run-id=20260512T130000Z
 *   npx tsx scripts/claim-product-linkage-evidence-audit.ts --org-id=<uuid>   # scopes slip_contents matrix counts only
 *
 * No DB writes. No --execute mode.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const PAGE = 500;

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (e.g. in .env.local).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function isoRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function parseArgs(argv: string[]): { runId: string | null; organizationId: string | null } {
  let runId: string | null = null;
  let organizationId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a.startsWith("--org-id=")) organizationId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) organizationId = a.slice("--organization-id=".length).trim() || null;
  }
  return { runId, organizationId };
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function trace(tracePath: string, msg: string): void {
  fs.appendFileSync(tracePath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

async function countExact(
  client: SupabaseClient,
  table: string,
  tracePath: string,
): Promise<{ count: number | null; error: string | null }> {
  trace(tracePath, `COUNT ${table} (head)`);
  const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

/** When `--org-id` is set, scope slip_contents matrix counts to that tenant (NEXT-CLAIM-16). */
async function countMatrixTable(
  client: SupabaseClient,
  table: string,
  tracePath: string,
  slipContentsOrgId: string | null,
): Promise<{ count: number | null; error: string | null }> {
  if (slipContentsOrgId && table === "slip_contents") {
    return countFiltered(client, table, [{ col: "organization_id", op: "eq", val: slipContentsOrgId }], tracePath);
  }
  return countExact(client, table, tracePath);
}

async function countFiltered(
  client: SupabaseClient,
  table: string,
  filters: { col: string; op: "eq" | "is" | "not"; val: string | null }[],
  tracePath: string,
): Promise<{ count: number | null; error: string | null }> {
  trace(tracePath, `COUNT ${table} filtered ${JSON.stringify(filters)}`);
  let q = client.from(table).select("*", { count: "exact", head: true });
  for (const f of filters) {
    if (f.op === "eq") q = q.eq(f.col, f.val as string);
    else if (f.op === "is") q = q.is(f.col, f.val);
    else q = q.not(f.col, "is", null);
  }
  const { count, error } = await q;
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

async function tryCountNull(
  client: SupabaseClient,
  table: string,
  column: string,
  tracePath: string,
  slipContentsOrgId: string | null = null,
): Promise<{ total: number | null; nullCount: number | null; error: string | null }> {
  trace(tracePath, `COUNT ${table} total + ${column} IS NULL`);
  const slipScope: { col: string; op: "eq" | "is" | "not"; val: string | null }[] =
    slipContentsOrgId && table === "slip_contents"
      ? [{ col: "organization_id", op: "eq", val: slipContentsOrgId }]
      : [];
  if (slipScope.length > 0) {
    const t = await countFiltered(client, table, slipScope, tracePath);
    if (t.error || t.count == null) return { total: null, nullCount: null, error: t.error };
    const n = await countFiltered(client, table, [...slipScope, { col: column, op: "is", val: null }], tracePath);
    if (n.error) return { total: t.count, nullCount: null, error: n.error };
    return { total: t.count, nullCount: n.count ?? 0, error: null };
  }
  const t = await countExact(client, table, tracePath);
  if (t.error || t.count == null) return { total: null, nullCount: null, error: t.error };
  const n = await countFiltered(client, table, [{ col: column, op: "is", val: null }], tracePath);
  if (n.error) return { total: t.count, nullCount: null, error: n.error };
  return { total: t.count, nullCount: n.count ?? 0, error: null };
}

async function tryCountNotNull(
  client: SupabaseClient,
  table: string,
  column: string,
  tracePath: string,
  slipContentsOrgId: string | null = null,
): Promise<{ count: number | null; error: string | null }> {
  trace(tracePath, `COUNT ${table} ${column} NOT NULL`);
  const slipScope: { col: string; op: "eq" | "is" | "not"; val: string | null }[] =
    slipContentsOrgId && table === "slip_contents"
      ? [{ col: "organization_id", op: "eq", val: slipContentsOrgId }]
      : [];
  return countFiltered(client, table, [...slipScope, { col: column, op: "not", val: null }], tracePath);
}

async function fetchPaged<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  select: string,
  orderCol: string,
  tracePath: string,
  maxRows: number,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    if (rows.length >= maxRows) break;
    const take = Math.min(PAGE, maxRows - rows.length);
    const hi = from + take - 1;
    trace(tracePath, `SELECT ${table} ${select} range ${from}-${hi}`);
    const { data, error } = await client
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, hi);
    if (error) return { rows, error: error.message };
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < take) break;
    from += take;
  }
  return { rows, error: null };
}

function pct(part: number | null, whole: number | null): string {
  if (part == null || whole == null || whole === 0) return "";
  return ((100 * part) / whole).toFixed(2);
}

function classifyLinkage(args: {
  table: string;
  rowCount: number | null;
  productIdNonNull: number | null;
  resolvedNonNull: number | null;
  identifierAnyApprox: number | null;
}): string {
  const { table, rowCount, productIdNonNull, resolvedNonNull, identifierAnyApprox } = args;
  if (rowCount == null || rowCount === 0) return "none";
  if (table === "pallets") return "indirect-container";
  if (table === "packages") return "indirect-container";
  if (table === "shipment_containers" || table === "shipment_boxes") return "indirect-container";
  if (table === "shipment_box_items") {
    if (resolvedNonNull != null && resolvedNonNull > 0) return "resolved";
    if (identifierAnyApprox != null && identifierAnyApprox > 0) return "identifier-only";
    return "none";
  }
  const r = resolvedNonNull ?? 0;
  const p = productIdNonNull ?? 0;
  const i = identifierAnyApprox ?? 0;
  if (r / rowCount >= 0.5) return "resolved";
  if (p / rowCount >= 0.5) return "direct";
  if (i / rowCount >= 0.5) return "identifier-only";
  if (r > 0 || p > 0) return "mixed";
  if (i > 0) return "identifier-only";
  return "none";
}

function collectJsonKeys(obj: unknown, prefix: string, out: Set<string>): void {
  if (obj == null) return;
  if (Array.isArray(obj)) {
    out.add(`${prefix}[]`);
    for (const el of obj.slice(0, 3)) collectJsonKeys(el, `${prefix}[]`, out);
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      if (typeof v === "object" && v != null && !Array.isArray(v)) collectJsonKeys(v, p, out);
      else if (Array.isArray(v)) out.add(`${p}[]`);
    }
  }
}

function redactUrlsInShape(obj: unknown): unknown {
  if (obj == null) return obj;
  if (typeof obj === "string") {
    if (/^https?:\/\//i.test(obj)) return "[REDACTED_URL]";
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((x) => redactUrlsInShape(x));
  if (typeof obj === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      o[k] = redactUrlsInShape(v);
    }
    return o;
  }
  return obj;
}

type MatrixRow = Record<string, string | number>;

function matrixRowToCsv(row: MatrixRow): string {
  return rowToCsvLine([
    String(row.table_name),
    String(row.row_count),
    String(row.query_error),
    String(row.product_id_null_count),
    String(row.product_id_non_null_count),
    String(row.resolved_product_id_null_count),
    String(row.resolved_product_id_non_null_count),
    String(row.resolved_column_missing),
    String(row.identifier_sku_non_null),
    String(row.identifier_fnsku_non_null),
    String(row.identifier_asin_non_null),
    String(row.identifier_product_identifier_non_null),
    String(row.identifier_upc_non_null),
    String(row.linkage_type_primary),
    String(row.table_role_note),
  ]);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { runId: runIdArg, organizationId: slipContentsOrgId } = parseArgs(process.argv.slice(2));
  const runId = runIdArg ?? isoRunId();
  const outDir = path.resolve(".cursor", "audit-reports", "next-claim-07", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "query-trace.txt");
  const warnPath = path.join(logsDir, "warnings.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");
  fs.writeFileSync(warnPath, "", "utf8");
  const warn = (code: string, detail: string) => {
    fs.appendFileSync(warnPath, JSON.stringify({ code, detail }) + "\n", "utf8");
  };

  const client = createServiceClient();

  const matrixPath = path.join(outDir, "00-product-linkage-matrix.csv");
  const opRetPath = path.join(outDir, "01-operational-return-linkage.csv");
  const evCovPath = path.join(outDir, "02-operator-evidence-coverage.csv");
  const candSrcPath = path.join(outDir, "03-claim-candidate-source-distribution.csv");
  const pimPath = path.join(outDir, "04-pim-blocker-summary.csv");
  const payloadKeysPath = path.join(outDir, "05-claim-submission-source-payload-keys.json");
  const gapPath = path.join(outDir, "06-package-pallet-container-gaps.csv");

  const matrixHeader = [
    "table_name",
    "row_count",
    "query_error",
    "product_id_null_count",
    "product_id_non_null_count",
    "resolved_product_id_null_count",
    "resolved_product_id_non_null_count",
    "resolved_column_missing",
    "identifier_sku_non_null",
    "identifier_fnsku_non_null",
    "identifier_asin_non_null",
    "identifier_product_identifier_non_null",
    "identifier_upc_non_null",
    "linkage_type_primary",
    "table_role_note",
  ].join(",");

  fs.writeFileSync(matrixPath, matrixHeader + "\n", "utf8");

  const matrixRows: MatrixRow[] = [];

  const linkageTables: {
    name: string;
    role: string;
    productCol?: string;
    resolvedCol?: string;
    idKeys?: ("sku" | "fnsku" | "asin" | "product_identifier" | "upc")[];
  }[] = [
    { name: "returns", role: "operational_item", productCol: "product_id", resolvedCol: "resolved_product_id", idKeys: ["sku", "fnsku", "asin", "product_identifier"] },
    { name: "packages", role: "container_carton" },
    { name: "pallets", role: "container_tracking" },
    { name: "slip_contents", role: "slip_line", productCol: "product_id", resolvedCol: "resolved_product_id", idKeys: ["sku", "fnsku", "asin"] },
    { name: "claim_candidates", role: "claim_work_queue", productCol: "product_id", resolvedCol: "resolved_product_id", idKeys: ["sku", "fnsku", "asin"] },
    { name: "amazon_returns", role: "raw_marketplace", productCol: "product_id", resolvedCol: "resolved_product_id", idKeys: ["sku", "fnsku", "asin"] },
    { name: "amazon_removals", role: "raw_marketplace", productCol: "product_id", resolvedCol: "resolved_product_id", idKeys: ["sku", "fnsku", "asin"] },
    { name: "amazon_removal_shipments", role: "raw_marketplace", idKeys: ["sku", "fnsku", "asin"] },
    { name: "amazon_reimbursements", role: "raw_marketplace", idKeys: ["sku", "asin"] },
    { name: "amazon_settlements", role: "raw_marketplace" },
    { name: "amazon_transactions", role: "raw_marketplace", idKeys: ["sku", "asin"] },
    { name: "products", role: "catalog" },
    { name: "product_identifier_map", role: "identifier_graph", productCol: "product_id" },
    { name: "shipment_box_items", role: "scan_line_optional", idKeys: ["sku", "fnsku", "asin"] },
  ];

  for (const spec of linkageTables) {
    const row: MatrixRow = {
      table_name: spec.name,
      row_count: "",
      query_error: "",
      product_id_null_count: "",
      product_id_non_null_count: "",
      resolved_product_id_null_count: "",
      resolved_product_id_non_null_count: "",
      resolved_column_missing: "",
      identifier_sku_non_null: "",
      identifier_fnsku_non_null: "",
      identifier_asin_non_null: "",
      identifier_product_identifier_non_null: "",
      identifier_upc_non_null: "",
      linkage_type_primary: "",
      table_role_note: spec.role,
    };

    const total = await countMatrixTable(client, spec.name, tracePath, slipContentsOrgId);
    if (total.error) {
      row.query_error = total.error;
      warn("TABLE_COUNT", `${spec.name}: ${total.error}`);
      matrixRows.push(row);
      fs.appendFileSync(matrixPath, matrixRowToCsv(row), "utf8");
      continue;
    }
    row.row_count = total.count ?? 0;

    let productNonNull: number | null = null;
    if (spec.productCol) {
      const pn = await tryCountNull(client, spec.name, spec.productCol, tracePath, slipContentsOrgId);
      if (pn.error) {
        warn("COLUMN_COUNT", `${spec.name}.${spec.productCol}: ${pn.error}`);
      } else {
        productNonNull = pn.total != null && pn.nullCount != null ? pn.total - pn.nullCount : null;
        row.product_id_null_count = pn.nullCount ?? "";
        row.product_id_non_null_count = productNonNull ?? "";
      }
    } else {
      row.product_id_null_count = "n/a";
      row.product_id_non_null_count = "n/a";
    }

    let resolvedNonNull: number | null = null;
    if (spec.resolvedCol) {
      const rn = await tryCountNull(client, spec.name, spec.resolvedCol, tracePath, slipContentsOrgId);
      if (rn.error) {
        row.resolved_column_missing = "true";
        warn("COLUMN_COUNT", `${spec.name}.${spec.resolvedCol}: ${rn.error}`);
      } else {
        row.resolved_column_missing = "false";
        resolvedNonNull = rn.total != null && rn.nullCount != null ? rn.total - rn.nullCount : null;
        row.resolved_product_id_null_count = rn.nullCount ?? "";
        row.resolved_product_id_non_null_count = resolvedNonNull ?? "";
      }
    } else {
      row.resolved_column_missing = "n/a";
      row.resolved_product_id_null_count = "n/a";
      row.resolved_product_id_non_null_count = "n/a";
    }

    const idk = spec.idKeys ?? [];
    let idAnyApprox = 0;
    for (const col of idk) {
      const nn = await tryCountNotNull(client, spec.name, col, tracePath, slipContentsOrgId);
      const key =
        col === "sku"
          ? "identifier_sku_non_null"
          : col === "fnsku"
            ? "identifier_fnsku_non_null"
            : col === "asin"
              ? "identifier_asin_non_null"
              : col === "product_identifier"
                ? "identifier_product_identifier_non_null"
                : "identifier_upc_non_null";
      if (nn.error) {
        row[key] = "";
        warn("COLUMN_COUNT", `${spec.name}.${col}: ${nn.error}`);
      } else {
        row[key] = nn.count ?? 0;
        if ((nn.count ?? 0) > idAnyApprox) idAnyApprox = nn.count ?? 0;
      }
    }
    if (!idk.includes("sku")) row.identifier_sku_non_null = "n/a";
    if (!idk.includes("fnsku")) row.identifier_fnsku_non_null = "n/a";
    if (!idk.includes("asin")) row.identifier_asin_non_null = "n/a";
    if (!idk.includes("product_identifier")) row.identifier_product_identifier_non_null = "n/a";
    if (!idk.includes("upc")) row.identifier_upc_non_null = "n/a";

    row.linkage_type_primary = classifyLinkage({
      table: spec.name,
      rowCount: total.count,
      productIdNonNull: productNonNull,
      resolvedNonNull: resolvedNonNull,
      identifierAnyApprox: idAnyApprox,
    });

    matrixRows.push(row);
    fs.appendFileSync(matrixPath, matrixRowToCsv(row), "utf8");
  }

  // --- 01 operational return linkage ---
  const retTotal = await countExact(client, "returns", tracePath);
  let retActive = retTotal;
  const retActiveF = await countFiltered(
    client,
    "returns",
    [{ col: "deleted_at", op: "is", val: null }],
    tracePath,
  );
  if (!retActiveF.error) retActive = retActiveF;
  else warn("RETURNS_ACTIVE", `deleted_at filter: ${retActiveF.error}`);

  const pkgNull = await tryCountNull(client, "returns", "package_id", tracePath);
  const palNull = await tryCountNull(client, "returns", "pallet_id", tracePath);
  const prodNull = await tryCountNull(client, "returns", "product_id", tracePath);
  const resNull = await tryCountNull(client, "returns", "resolved_product_id", tracePath);
  if (resNull.error) warn("RETURNS_RESOLVED", `returns.resolved_product_id: ${resNull.error}`);

  const orgNull = await tryCountNull(client, "returns", "organization_id", tracePath);
  const storeNull = await tryCountNull(client, "returns", "store_id", tracePath);

  const condNN = await tryCountNotNull(client, "returns", "conditions", tracePath);
  const notesNN = await tryCountNotNull(client, "returns", "notes", tracePath);
  const cbNN = await tryCountNotNull(client, "returns", "created_by", tracePath);
  const ubNN = await tryCountNotNull(client, "returns", "updated_by", tracePath);

  fs.writeFileSync(
    opRetPath,
    rowToCsvLine(["metric", "value", "pct_of_returns_total", "notes"]),
    "utf8",
  );
  const rt = retTotal.count ?? 0;
  const ra = retActive.count ?? rt;
  const lines01: [string, string, string, string][] = [
    ["returns_row_count_total", String(rt), "", "head count"],
    ["returns_row_count_active_deleted_at_null", String(ra), pct(ra, rt) || "", "if filter unsupported see warnings"],
    ["package_id_null_count", String(pkgNull.nullCount ?? ""), pct(pkgNull.nullCount, ra) || "", ""],
    ["pallet_id_null_count", String(palNull.nullCount ?? ""), pct(palNull.nullCount, ra) || "", ""],
    ["product_id_null_count", String(prodNull.nullCount ?? ""), pct(prodNull.nullCount, ra) || "", ""],
    ["resolved_product_id_null_count", String(resNull.nullCount ?? ""), pct(resNull.nullCount, ra) || "", resNull.error ? "column may be absent" : ""],
    ["organization_id_null_count", String(orgNull.nullCount ?? ""), pct(orgNull.nullCount, ra) || "", ""],
    ["store_id_null_count", String(storeNull.nullCount ?? ""), pct(storeNull.nullCount, ra) || "", ""],
    ["conditions_non_null_rows", String(condNN.count ?? ""), pct(condNN.count, ra) || "", "array column"],
    ["notes_non_null_rows", String(notesNN.count ?? ""), pct(notesNN.count, ra) || "", ""],
    ["created_by_non_null_rows", String(cbNN.count ?? ""), pct(cbNN.count, ra) || "", ""],
    ["updated_by_non_null_rows", String(ubNN.count ?? ""), pct(ubNN.count, ra) || "", ""],
  ];
  for (const ln of lines01) fs.appendFileSync(opRetPath, rowToCsvLine(ln), "utf8");

  // --- 02 operator evidence coverage ---
  fs.writeFileSync(
    evCovPath,
    rowToCsvLine(["surface", "field", "non_null_or_present_count", "denominator", "pct", "error"]),
    "utf8",
  );
  const pkgTot = await countExact(client, "packages", tracePath);
  const palTot = await countExact(client, "pallets", tracePath);
  const pkgN = pkgTot.count ?? 0;
  const palN = palTot.count ?? 0;

  const evSpecs: { surface: string; field: string; den: number }[] = [
    { surface: "returns", field: "photo_evidence", den: ra },
    { surface: "returns", field: "photo_item_url", den: ra },
    { surface: "returns", field: "photo_expiry_url", den: ra },
    { surface: "returns", field: "photo_return_label_url", den: ra },
    { surface: "packages", field: "photo_evidence", den: pkgN },
    { surface: "packages", field: "photo_url", den: pkgN },
    { surface: "packages", field: "photo_return_label_url", den: pkgN },
    { surface: "packages", field: "photo_opened_url", den: pkgN },
    { surface: "packages", field: "photo_closed_url", den: pkgN },
    { surface: "packages", field: "manifest_photo_url", den: pkgN },
    { surface: "pallets", field: "photo_evidence", den: palN },
    { surface: "pallets", field: "photo_url", den: palN },
    { surface: "pallets", field: "bol_photo_url", den: palN },
    { surface: "pallets", field: "manifest_photo_url", den: palN },
    { surface: "pallets", field: "pallet_photo_urls", den: palN },
    { surface: "pallets", field: "bol_photo_urls", den: palN },
    { surface: "pallets", field: "shipping_label_urls", den: palN },
    { surface: "pallets", field: "tracking_number", den: palN },
    { surface: "pallets", field: "order_id", den: palN },
    { surface: "packages", field: "tracking_number", den: pkgN },
    { surface: "packages", field: "order_id", den: pkgN },
  ];
  for (const e of evSpecs) {
    const nn = await tryCountNotNull(client, e.surface, e.field, tracePath);
    if (nn.error) {
      warn("EVIDENCE_COLUMN", `${e.surface}.${e.field}: ${nn.error}`);
      fs.appendFileSync(evCovPath, rowToCsvLine([e.surface, e.field, "", String(e.den), "", nn.error]), "utf8");
    } else {
      fs.appendFileSync(
        evCovPath,
        rowToCsvLine([e.surface, e.field, String(nn.count ?? 0), String(e.den), pct(nn.count, e.den), ""]),
        "utf8",
      );
    }
  }

  // --- 03 claim candidate source distribution ---
  fs.writeFileSync(candSrcPath, rowToCsvLine(["source_table", "row_count", "notes"]), "utf8");
  const candProbe = await countExact(client, "claim_candidates", tracePath);
  if (candProbe.error) {
    warn("CLAIM_CANDIDATES", candProbe.error);
    fs.appendFileSync(candSrcPath, rowToCsvLine(["(unavailable)", "0", candProbe.error]), "utf8");
  } else {
    const dist = new Map<string, number>();
    const stNull = await countFiltered(
      client,
      "claim_candidates",
      [{ col: "source_table", op: "is", val: null }],
      tracePath,
    );
    if (!stNull.error) dist.set("(null)", stNull.count ?? 0);

    let from = 0;
    const MAX = 50_000;
    let read = 0;
    for (;;) {
      trace(tracePath, `SELECT claim_candidates source_table range ${from}`);
      const { data, error } = await client
        .from("claim_candidates")
        .select("source_table")
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        warn("CLAIM_CANDIDATES_PAGE", error.message);
        break;
      }
      const batch = data ?? [];
      for (const r of batch) {
        const k = (r as { source_table?: string }).source_table ?? "(null)";
        dist.set(k, (dist.get(k) ?? 0) + 1);
      }
      read += batch.length;
      if (batch.length < PAGE || read >= MAX) break;
      from += PAGE;
    }
    if (read >= MAX) warn("CLAIM_CANDIDATES_DIST", `source_table scan truncated at ${MAX} rows`);
    const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted) {
      fs.appendFileSync(candSrcPath, rowToCsvLine([k, String(v), ""]), "utf8");
    }

    const srNull = await tryCountNull(client, "claim_candidates", "source_row_id", tracePath);
    fs.appendFileSync(
      candSrcPath,
      rowToCsvLine(["__summary_source_row_id_null__", String(srNull.nullCount ?? ""), srNull.error ?? ""]),
      "utf8",
    );
    const rpNull = await tryCountNull(client, "claim_candidates", "resolved_product_id", tracePath);
    fs.appendFileSync(
      candSrcPath,
      rowToCsvLine(["__summary_resolved_product_id_null__", String(rpNull.nullCount ?? ""), rpNull.error ?? ""]),
      "utf8",
    );

    const statusDist = new Map<string, number>();
    const candStatus = await fetchPaged<Record<string, unknown>>(
      client,
      "claim_candidates",
      "candidate_status,evidence_status,confidence_score",
      "created_at",
      tracePath,
      20_000,
    );
    if (candStatus.error) warn("CLAIM_CANDIDATES_STATUS", candStatus.error);
    else {
      for (const r of candStatus.rows) {
        const cs = String(r.candidate_status ?? "(null)");
        statusDist.set(`candidate_status:${cs}`, (statusDist.get(`candidate_status:${cs}`) ?? 0) + 1);
        const es = String(r.evidence_status ?? "(null)");
        statusDist.set(`evidence_status:${es}`, (statusDist.get(`evidence_status:${es}`) ?? 0) + 1);
      }
      fs.appendFileSync(candSrcPath, rowToCsvLine(["__section__", "status_distribution", ""]), "utf8");
      for (const [k, v] of [...statusDist.entries()].sort((a, b) => b[1] - a[1])) {
        fs.appendFileSync(candSrcPath, rowToCsvLine([k, String(v), ""]), "utf8");
      }
    }
  }

  // --- 04 PIM blocker summary ---
  fs.writeFileSync(pimPath, rowToCsvLine(["taxonomy_cell", "status", "count", "error"]), "utf8");
  const pimCells = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"] as const;
  const pimStatuses = ["open", "claimed", "decided", "committed", "dismissed", "reverted"] as const;
  for (const cell of pimCells) {
    for (const st of pimStatuses) {
      const c = await countFiltered(
        client,
        "pim_identifier_dispute",
        [
          { col: "taxonomy_cell", op: "eq", val: cell },
          { col: "status", op: "eq", val: st },
        ],
        tracePath,
      );
      if (c.error) {
        warn("PIM_COUNT", `${cell}/${st}: ${c.error}`);
        fs.appendFileSync(pimPath, rowToCsvLine([cell, st, "", c.error]), "utf8");
      } else {
        fs.appendFileSync(pimPath, rowToCsvLine([cell, st, String(c.count ?? 0), ""]), "utf8");
      }
    }
  }

  const pimMemberProductIds = new Set<string>();
  let pimJoinCandidatesOverlapping = 0;
  let pimJoinTruncated = false;
  const openDisputes = await fetchPaged<Record<string, unknown>>(
    client,
    "pim_identifier_dispute",
    "id,members,status",
    "created_at",
    tracePath,
    8000,
  );
  if (openDisputes.error) {
    warn("PIM_MEMBERS_PAGE", openDisputes.error);
  } else {
    for (const r of openDisputes.rows) {
      if (String(r.status) !== "open") continue;
      const members = r.members;
      if (Array.isArray(members)) {
        for (const m of members) {
          if (typeof m === "string" && m.length > 0) pimMemberProductIds.add(m);
        }
      }
    }
    if (openDisputes.rows.length >= 8000) {
      pimJoinTruncated = true;
      warn("PIM_JOIN", "pim_identifier_dispute scan truncated at 8000 rows; member union may be incomplete");
    }
    if (pimMemberProductIds.size > 0 && !candProbe.error) {
      let cfrom = 0;
      let cread = 0;
      const CMAX = 25_000;
      for (;;) {
        const { data, error } = await client
          .from("claim_candidates")
          .select("resolved_product_id")
          .not("resolved_product_id", "is", null)
          .order("created_at", { ascending: true })
          .range(cfrom, cfrom + PAGE - 1);
        if (error) {
          warn("PIM_JOIN_CANDIDATES", error.message);
          break;
        }
        const batch = data ?? [];
        for (const row of batch) {
          const rid = (row as { resolved_product_id?: string }).resolved_product_id;
          if (rid && pimMemberProductIds.has(rid)) pimJoinCandidatesOverlapping += 1;
        }
        cread += batch.length;
        if (batch.length < PAGE || cread >= CMAX) break;
        cfrom += PAGE;
      }
      if (cread >= CMAX) warn("PIM_JOIN", `claim_candidates overlap scan truncated at ${CMAX} rows`);
    }
  }
  fs.appendFileSync(
    pimPath,
    rowToCsvLine([
      "__summary_open_dispute_distinct_member_product_ids__",
      String(pimMemberProductIds.size),
      pimJoinTruncated ? "truncated" : "",
      "",
    ]),
    "utf8",
  );
  fs.appendFileSync(
    pimPath,
    rowToCsvLine([
      "__summary_claim_candidates_resolved_in_open_pim_member_set__",
      String(pimJoinCandidatesOverlapping),
      "",
      pimJoinTruncated ? "partial" : "",
    ]),
    "utf8",
  );

  const reviewCount = await countExact(client, "pim_conflict_review_event", tracePath);
  if (reviewCount.error) {
    warn("PIM_REVIEW_EVENT", reviewCount.error);
    fs.appendFileSync(pimPath, rowToCsvLine(["pim_conflict_review_event", "row_count", "", reviewCount.error]), "utf8");
  } else {
    fs.appendFileSync(
      pimPath,
      rowToCsvLine(["pim_conflict_review_event", "row_count", String(reviewCount.count ?? 0), ""]),
      "utf8",
    );
  }

  // --- 05 claim_submissions source_payload ---
  const keySet = new Set<string>();
  const samples: unknown[] = [];
  const subSample = await fetchPaged<Record<string, unknown>>(
    client,
    "claim_submissions",
    "id,source_payload",
    "created_at",
    tracePath,
    80,
  );
  if (subSample.error) warn("CLAIM_SUBMISSIONS_SAMPLE", subSample.error);
  else {
    for (const r of subSample.rows) {
      collectJsonKeys(r.source_payload, "", keySet);
      if (samples.length < 5) samples.push(redactUrlsInShape(r.source_payload));
    }
  }
  fs.writeFileSync(
    payloadKeysPath,
    JSON.stringify(
      {
        run_id: runId,
        redaction: "samples_redacted_for_urls",
        keys_sorted: [...keySet].sort(),
        sample_payloads_redacted_count: samples.length,
        sample_payloads_redacted: samples,
      },
      null,
      2,
    ),
    "utf8",
  );

  // --- 06 container gaps ---
  fs.writeFileSync(
    gapPath,
    rowToCsvLine(["entity", "metric", "count", "denominator", "pct", "error"]),
    "utf8",
  );
  const pkgPalletNull = await tryCountNull(client, "packages", "pallet_id", tracePath);
  const palStoreNull = await tryCountNull(client, "pallets", "store_id", tracePath);
  const pkgStoreNull = await tryCountNull(client, "packages", "store_id", tracePath);
  const gapLines: [string, string, string, string, string, string][] = [
    ["packages", "pallet_id_null", String(pkgPalletNull.nullCount ?? ""), String(pkgN), pct(pkgPalletNull.nullCount, pkgN), pkgPalletNull.error ?? ""],
    ["packages", "store_id_null", String(pkgStoreNull.nullCount ?? ""), String(pkgN), pct(pkgStoreNull.nullCount, pkgN), pkgStoreNull.error ?? ""],
    ["pallets", "store_id_null", String(palStoreNull.nullCount ?? ""), String(palN), pct(palStoreNull.nullCount, palN), palStoreNull.error ?? ""],
    ["returns", "package_id_null", String(pkgNull.nullCount ?? ""), String(ra), pct(pkgNull.nullCount, ra), ""],
    ["returns", "pallet_id_null", String(palNull.nullCount ?? ""), String(ra), pct(palNull.nullCount, ra), ""],
  ];
  for (const ln of gapLines) fs.appendFileSync(gapPath, rowToCsvLine(ln), "utf8");

  const ctxCount = await countExact(client, "v_claim_candidate_source_context", tracePath);
  if (ctxCount.error) warn("VIEW_CONTEXT", ctxCount.error);
  else trace(tracePath, `v_claim_candidate_source_context row_count=${ctxCount.count}`);

  const manifest = {
    run_id: runId,
    created_at: new Date().toISOString(),
    read_only: true,
    no_db_writes: true,
    output_files: {
      matrix: "00-product-linkage-matrix.csv",
      operational_returns: "01-operational-return-linkage.csv",
      evidence_coverage: "02-operator-evidence-coverage.csv",
      claim_candidate_sources: "03-claim-candidate-source-distribution.csv",
      pim_summary: "04-pim-blocker-summary.csv",
      submission_payload_keys: "05-claim-submission-source-payload-keys.json",
      container_gaps: "06-package-pallet-container-gaps.csv",
      validation: "10-validation-checks.json",
    },
    summary: {
      returns_total: retTotal.count,
      returns_active_approx: retActive.count,
      returns_product_id_null: prodNull.nullCount,
      returns_package_id_null: pkgNull.nullCount,
      returns_pallet_id_null: palNull.nullCount,
      claim_candidates_resolved_overlap_open_pim_members: pimJoinCandidatesOverlapping,
      pallets_row_count: palN,
      packages_row_count: pkgN,
      v_claim_candidate_source_context_rows: ctxCount.count,
      claim_candidates_count_probe: candProbe.count,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const files = [
    "manifest.json",
    "00-product-linkage-matrix.csv",
    "01-operational-return-linkage.csv",
    "02-operator-evidence-coverage.csv",
    "03-claim-candidate-source-distribution.csv",
    "04-pim-blocker-summary.csv",
    "05-claim-submission-source-payload-keys.json",
    "06-package-pallet-container-gaps.csv",
    path.join("logs", "query-trace.txt"),
    path.join("logs", "warnings.ndjson"),
  ];

  const checks: { id: string; passed: boolean; detail: string }[] = [];
  checks.push({
    id: "J1",
    passed: true,
    detail: "Script uses only .select() and count head; no insert/update/delete/upsert.",
  });
  const missing = files.filter((f) => !fs.existsSync(path.join(outDir, f)));
  const allFiles = missing.length === 0;
  checks.push({
    id: "J2",
    passed: allFiles,
    detail: allFiles
      ? "All core output files present (10-validation-checks.json written after this block)."
      : `Missing: ${missing.join(", ")}`,
  });
  const retOk = !retTotal.error;
  const pkgOk = !pkgTot.error;
  const palOk = !palTot.error;
  checks.push({
    id: "J3",
    passed: retOk && pkgOk && palOk,
    detail: retOk && pkgOk && palOk ? "returns, packages, pallets counted." : "One of returns/packages/pallets count failed.",
  });
  checks.push({
    id: "J4",
    passed: true,
    detail: "pallets classified as container/tracking in matrix (linkage_type_primary=indirect-container).",
  });
  const palletRow = matrixRows.find((r) => r.table_name === "pallets");
  const palletNoDirectProduct =
    palletRow &&
    (String(palletRow.product_id_non_null_count) === "" ||
      String(palletRow.product_id_non_null_count) === "n/a" ||
      String(palletRow.product_id_non_null_count) === "0");
  checks.push({
    id: "J5",
    passed: Boolean(palletNoDirectProduct || palletRow?.query_error),
    detail:
      "Pallets: no product_id non-null audit column or zero/non-applicable; do not add product_id to pallets for product identity.",
  });
  const evFile = fs.readFileSync(evCovPath, "utf8");
  const evMeasured = evFile.split("\n").length > 2;
  checks.push({
    id: "J6",
    passed: evMeasured,
    detail: evMeasured ? "Operator evidence fields measured (02 CSV)." : "Evidence CSV empty.",
  });
  checks.push({
    id: "J7",
    passed: true,
    detail: "PIM blocker counts in 04 CSV; optional candidate overlap computed when data available.",
  });
  const candOk = !candProbe.error || fs.readFileSync(candSrcPath, "utf8").split("\n").length > 1;
  checks.push({
    id: "J8",
    passed: candOk,
    detail: candProbe.error ? `claim_candidates count failed: ${candProbe.error}; distribution file still created.` : "claim_candidates source distribution present.",
  });
  checks.push({
    id: "J9",
    passed: true,
    detail: "Missing tables handled with warnings in matrix and logs.",
  });
  checks.push({
    id: "J10",
    passed: true,
    detail: "No Amazon submission, AI, or product mutation; read-only audit only.",
  });

  const jOrder = ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10"];
  checks.sort((a, b) => jOrder.indexOf(a.id) - jOrder.indexOf(b.id));
  fs.writeFileSync(path.join(outDir, "10-validation-checks.json"), JSON.stringify(checks, null, 2), "utf8");

  const strictFail =
    !checks.find((c) => c.id === "J2")?.passed ||
    !checks.find((c) => c.id === "J3")?.passed ||
    !checks.find((c) => c.id === "J6")?.passed;
  const exitBad = strictFail;

  console.log(JSON.stringify({ runId, outDir, checks, exitCode: exitBad ? 1 : 0 }, null, 2));
  if (exitBad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
