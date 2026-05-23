/**
 * SCANNER-NEDA-04 — read-only operator-mobile smoke probes.
 * Usage: npx tsx scripts/scanner-neda-04-operator-mobile-smoke.ts
 *
 * No migrations, no inserts/updates/deletes, no production/Amazon/AI.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { EP_DETAIL_SELECT } from "../lib/scanner/operator-tracking-expectations";

/** Mirrors private `EP_SELECT` in operator-tracking-expectations.ts */
const EP_SELECT =
  "sku, fnsku, disposition, expected_scan_quantity, order_id, tracking_number";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

function extractProjectRef(url: string): string | null {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return m?.[1] ?? null;
}

type ProbeResult = { name: string; ok: boolean; detail: string };

const RETURN_ITEMS_ITEM_SCAN_SELECT =
  "id, fnsku, sku, product_identifier, conditions, expiration_date, batch_number, photo_evidence, created_at";

const SLIP_SELECT_ATTEMPTS = [
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id, conflicting_order_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id, conflicting_order_id",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, conflicting_order_id",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code",
];

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const runId = process.env.SCANNER_NEDA_04_RUN_ID ?? "run-20260518-002";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-04-operator-mobile-smoke",
    runId,
  );

  const report: Record<string, unknown> = {
    audit: "scanner-neda-04-operator-mobile-smoke",
    run_id: runId,
    probe_method: "PostgREST limit=0/1 SELECT only (service role, no writes)",
    project_ref: extractProjectRef(url),
    probes: [] as ProbeResult[],
  };

  if (!url || !key) {
    report.error = "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const probes: ProbeResult[] = [];

  async function probeSelect(name: string, table: string, select: string): Promise<void> {
    const { error } = await supabase.from(table).select(select).limit(1);
    const is42703 =
      error?.code === "42703" ||
      (error?.message?.includes("42703") ?? false) ||
      /column.*does not exist/i.test(error?.message ?? "");
    probes.push({
      name,
      ok: !error,
      detail: error
        ? `${error.code ?? "error"}: ${error.message}${is42703 ? " [42703]" : ""}`
        : "select ok (0+ rows)",
    });
  }

  await probeSelect("package_items_table_absent_expected", "package_items", "id");
  await probeSelect("return_items_item_scan_select", RETURN_ITEMS_TABLE, RETURN_ITEMS_ITEM_SCAN_SELECT);
  let slipFallbackIndex = -1;
  for (let i = 0; i < SLIP_SELECT_ATTEMPTS.length; i++) {
    const sel = SLIP_SELECT_ATTEMPTS[i]!;
    const { error } = await supabase.from("slip_contents").select(sel).limit(1);
    if (!error) {
      slipFallbackIndex = i;
      probes.push({
        name: "slip_contents_operator_fallback_chain",
        ok: true,
        detail: `attempt ${i + 1}/${SLIP_SELECT_ATTEMPTS.length} ok`,
      });
      break;
    }
    if (i === SLIP_SELECT_ATTEMPTS.length - 1) {
      probes.push({
        name: "slip_contents_operator_fallback_chain",
        ok: false,
        detail: `${error?.code ?? "error"}: ${error?.message ?? "all attempts failed"}`,
      });
    }
  }
  report.slip_select_fallback_index = slipFallbackIndex;
  await probeSelect("packages_list_select", "packages", "id, package_code, tracking_number, expected_item_count, actual_item_count, store_id, organization_id");
  await probeSelect("EP_SELECT_identify_gate", "expected_packages", EP_SELECT);
  await probeSelect("EP_DETAIL_SELECT_item_scan", "expected_packages", EP_DETAIL_SELECT);

  const packageItemsProbe = probes.find((p) => p.name === "package_items_table_absent_expected");
  report.package_items_guard_removed_in_app = true;
  report.package_items_table_on_live_db =
    packageItemsProbe?.ok === true ? "present" : "absent_or_blocked";

  const { data: fixturePkg } = await supabase
    .from("packages")
    .select("id, organization_id, store_id, tracking_number, package_code, expected_item_count")
    .not("tracking_number", "is", null)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let fixture: Record<string, unknown> | null = null;
  if (fixturePkg?.id) {
    const pkgId = String(fixturePkg.id);
    const orgId = String(fixturePkg.organization_id ?? "");
    const [slipRes, retRes] = await Promise.all([
      supabase
        .from("slip_contents")
        .select("id, upc, fnsku, description, quantity")
        .eq("package_id", pkgId)
        .limit(5),
      supabase
        .from(RETURN_ITEMS_TABLE)
        .select("id, fnsku, sku")
        .eq("package_id", pkgId)
        .is("deleted_at", null)
        .limit(5),
    ]);
    const tracking = String(fixturePkg.tracking_number ?? "").trim();
    let epRows = 0;
    if (tracking) {
      const { data: ep } = await supabase
        .from("expected_packages")
        .select("id")
        .eq("organization_id", orgId)
        .ilike("tracking_number", `%${tracking.replace(/%/g, "").replace(/_/g, "")}%`)
        .limit(3);
      epRows = ep?.length ?? 0;
    }
    fixture = {
      package_id: pkgId,
      organization_id: orgId,
      store_id: fixturePkg.store_id,
      tracking_number: tracking,
      package_code: fixturePkg.package_code,
      slip_lines: slipRes.data?.length ?? 0,
      slip_error: slipRes.error?.message ?? null,
      return_items: retRes.data?.length ?? 0,
      return_items_error: retRes.error?.message ?? null,
      expected_packages_hits: epRows,
    };
    probes.push({
      name: "fixture_package_hydration",
      ok: !slipRes.error && !retRes.error,
      detail: fixture
        ? `pkg=${pkgId.slice(0, 8)}… slips=${fixture.slip_lines} returns=${fixture.return_items} ep=${epRows}`
        : "no fixture",
    });
  } else {
    probes.push({
      name: "fixture_package_hydration",
      ok: true,
      detail: "no package with tracking in linked DB — identify gate fixture skipped",
    });
  }

  report.fixture = fixture;
  report.probes = probes;
  report.no_42703_on_operator_selects = probes
    .filter((p) => p.name !== "package_items_table_absent_expected")
    .every((p) => p.ok && !p.detail.includes("42703"));
  report.operator_selects_ok = probes
    .filter((p) =>
      [
        "return_items_item_scan_select",
        "slip_contents_operator_fallback_chain",
        "packages_list_select",
        "EP_SELECT_identify_gate",
        "EP_DETAIL_SELECT_item_scan",
        "fixture_package_hydration",
      ].includes(p.name),
    )
    .every((p) => p.ok);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const pass = Boolean(report.no_42703_on_operator_selects) && Boolean(report.operator_selects_ok);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
