/**
 * SCANNER-NEDA-10 — operator-mobile BOX item scan wired to server actions (static + read-only DB).
 * Usage: npx tsx scripts/scanner-neda-10-mobile-wire-to-server-actions.ts
 *
 * Prerequisite: scanner-backend-contract-sync-v165 + scanner-neda-08/09 pass.
 * No migrations, no inserts/updates/deletes, no production prompts.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";

const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const NEDA_06_ROW_ID = "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663";
const SAMPLE_FNSKU = "X004N9OS4J";

const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");
const OPERATOR_MOBILE_ROOT = join(process.cwd(), "app/scanner/operator-mobile");
const ITEM_SCAN_SURFACE = [
  "app/scanner/operator-mobile/scan/page.tsx",
  "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx",
  "app/scanner/operator-mobile/_components/operator-store-actions.ts",
  "app/scanner/operator-mobile/item-actions.ts",
];

type Step = { step: string; ok: boolean; detail: string };

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
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function extractProjectRef(url: string): string | null {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return m?.[1] ?? null;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
  }
  return out;
}

function rel(p: string): string {
  return p.replace(process.cwd(), "").replace(/\\/g, "/");
}

function scanForbiddenInSurface(): {
  package_items: { file: string; line: number; snippet: string }[];
  returns_from: { file: string; line: number; snippet: string }[];
  products_insert: { file: string; line: number; snippet: string }[];
  browser_writes: { file: string; line: number; snippet: string }[];
} {
  const package_items: { file: string; line: number; snippet: string }[] = [];
  const returns_from: { file: string; line: number; snippet: string }[] = [];
  const products_insert: { file: string; line: number; snippet: string }[] = [];
  const browser_writes: { file: string; line: number; snippet: string }[] = [];

  const writeRe =
    /supabase\.(from|rpc)\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(|\.from\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(/;

  for (const relPath of ITEM_SCAN_SURFACE) {
    const abs = join(process.cwd(), relPath);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    const isServerActions = relPath.includes("operator-store-actions") || relPath.includes("item-actions");
    lines.forEach((line, i) => {
      const n = i + 1;
      if (/package_items/.test(line)) {
        package_items.push({ file: relPath, line: n, snippet: line.trim().slice(0, 120) });
      }
      if (/\.from\(["']returns["']\)/.test(line)) {
        returns_from.push({ file: relPath, line: n, snippet: line.trim().slice(0, 120) });
      }
      if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(line)) {
        products_insert.push({ file: relPath, line: n, snippet: line.trim().slice(0, 120) });
      }
      if (!isServerActions && writeRe.test(line) && relPath.includes("scan/page.tsx")) {
        browser_writes.push({ file: relPath, line: n, snippet: line.trim().slice(0, 120) });
      }
    });
  }
  return { package_items, returns_from, products_insert, browser_writes };
}

function scanPageWiring(): Record<string, boolean | number> {
  const text = readFileSync(SCAN_PAGE, "utf8");
  return {
    import_listOperatorSlipContentsForPackageAction: text.includes("listOperatorSlipContentsForPackageAction"),
    import_listOperatorPackageItemsForPackageAction: text.includes("listOperatorPackageItemsForPackageAction"),
    import_insertOperatorPackageItemAction: text.includes("insertOperatorPackageItemAction"),
    import_resolveItemBarcodeAgainstSlipRows: text.includes("resolveItemBarcodeAgainstSlipRows"),
    effect_hydrate_package_items: /listOperatorPackageItemsForPackageAction[\s\S]{0,400}aggregateOperatorPackageItemRows/.test(
      text,
    ),
    effect_slip_lines_itemInspection: /setItemInspectionSlipLines[\s\S]{0,200}listOperatorSlipContentsForPackageAction/.test(
      text,
    ),
    saveItemUnitModal_insert:
      /const saveItemUnitModal[\s\S]*insertOperatorPackageItemAction/.test(text),
    saveItemUnitModal_resolve:
      /const saveItemUnitModal[\s\S]*resolveItemBarcodeAgainstSlipRows/.test(text),
    handleItemBarcodeScan_resolve:
      /const handleItemBarcodeScan[\s\S]*resolveItemBarcodeAgainstSlipRows/.test(text),
    hydration_nonce_bump: /setPackageItemsHydrationNonce/.test(text),
    itemInspectionSlipCells_ui: text.includes("itemInspectionSlipCells"),
    progressive_row_styling: text.includes("itemInspectionSlipLinePresentation"),
    sticky_header_items: text.includes("Expected Items"),
  };
}

function staticOperatorMobileTree(): { package_items_refs: string[]; products_insert: boolean } {
  const files = walkTsFiles(OPERATOR_MOBILE_ROOT);
  const package_items_refs: string[] = [];
  let products_insert = false;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (/package_items/.test(text)) package_items_refs.push(rel(f));
    if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(text)) products_insert = true;
  }
  return { package_items_refs, products_insert };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.SCANNER_NEDA_10_RUN_ID ?? "run-20260518-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-10-mobile-wire-to-server-actions",
    runId,
  );

  const steps: Step[] = [];
  const report: Record<string, unknown> = {
    audit: "scanner-neda-10-mobile-wire-to-server-actions",
    run_id: runId,
    date: "2026-05-18",
    owner: "Neda",
    contract: "scanner-backend-contract-sync-v165/run-20260518-001/neda-handoff.md",
    fixture_package_id: FIXTURE_PACKAGE_ID,
    steps: [] as Step[],
  };

  function step(name: string, ok: boolean, detail: string): void {
    const s = { step: name, ok, detail };
    steps.push(s);
    (report.steps as Step[]).push(s);
  }

  const wiring = scanPageWiring();
  report.wiring = wiring;
  const wiringKeys = Object.keys(wiring).filter((k) => !k.startsWith("import_"));
  const wiringOk = wiringKeys.every((k) => wiring[k] === true);
  step(
    "scan_page_server_action_wiring",
    wiringOk && Object.entries(wiring).filter(([k]) => k.startsWith("import_")).every(([, v]) => v === true),
    JSON.stringify(wiring),
  );

  const forbidden = scanForbiddenInSurface();
  report.forbidden_surface_scan = forbidden;
  step(
    "forbidden_package_items_zero",
    forbidden.package_items.length === 0,
    forbidden.package_items.length
      ? forbidden.package_items.map((x) => `${x.file}:${x.line}`).join("; ")
      : "zero in item-scan surface",
  );
  step(
    "forbidden_returns_from_zero",
    forbidden.returns_from.length === 0,
    forbidden.returns_from.length ? JSON.stringify(forbidden.returns_from) : "zero .from('returns') in surface",
  );
  step(
    "forbidden_products_insert_zero",
    forbidden.products_insert.length === 0,
    forbidden.products_insert.length ? JSON.stringify(forbidden.products_insert) : "zero products.insert in surface",
  );
  step(
    "no_direct_browser_writes_item_scan",
    forbidden.browser_writes.length === 0,
    forbidden.browser_writes.length
      ? forbidden.browser_writes.map((x) => `${x.file}:${x.line}`).join("; ")
      : "item save/hydrate use server actions only (pallet create insert excluded from surface)",
  );

  const tree = staticOperatorMobileTree();
  report.operator_mobile_tree = tree;
  step(
    "operator_mobile_tree_no_package_items",
    tree.package_items_refs.length === 0,
    tree.package_items_refs.length ? tree.package_items_refs.join(", ") : "zero under operator-mobile",
  );
  step(
    "operator_mobile_tree_no_products_insert",
    !tree.products_insert,
    tree.products_insert ? "found products.insert" : "none",
  );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  report.project_ref = extractProjectRef(url);

  if (!url || !key) {
    step("env_credentials", false, "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    report.pass = false;
    writeArtifacts(outDir, runId, steps, report, wiring, forbidden, null);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  step("env_credentials", true, `project_ref=${report.project_ref ?? "?"}`);

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { error: piErr } = await supabase.from("package_items").select("id").limit(1);
  const piAbsent =
    piErr?.code === "PGRST205" || /Could not find the table/i.test(piErr?.message ?? "");
  step("live_package_items_absent", piAbsent || Boolean(piErr), piAbsent ? "PGRST205 (expected)" : piErr?.message ?? "ok");

  const { data: slipRows, error: slipErr } = await supabase
    .from("slip_contents")
    .select("id, upc, fnsku, description, quantity, sort_index")
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .order("sort_index", { ascending: true });

  step(
    "fixture_slip_contents",
    !slipErr && (slipRows?.length ?? 0) >= 2,
    slipErr?.message ?? `${slipRows?.length ?? 0} slip lines`,
  );

  const { data: retRows, error: retErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("id, fnsku, sku, product_identifier, package_id, organization_id, created_at")
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .is("deleted_at", null);

  step(
    "fixture_return_items_hydrate",
    !retErr && (retRows?.length ?? 0) > 0,
    retErr?.message ?? `${retRows?.length ?? 0} return_items rows`,
  );

  const slips: SlipBarcodeMatchRow[] = (slipRows ?? []).map((r) => ({
    id: String(r.id ?? ""),
    upc: r.upc as string | null,
    fnsku: r.fnsku as string | null,
    description: r.description as string | null,
    quantity: Number(r.quantity ?? 1),
    sort_index: Number(r.sort_index ?? 0),
  }));

  const fnskuOutcome = resolveItemBarcodeAgainstSlipRows(SAMPLE_FNSKU, slips);
  step(
    "client_resolve_sample_fnsku",
    fnskuOutcome.kind === "single",
    `${SAMPLE_FNSKU} → ${fnskuOutcome.kind}`,
  );

  const neda06 = (retRows ?? []).find((r) => String(r.id) === NEDA_06_ROW_ID);
  report.neda_06_row_present = Boolean(neda06);

  const critical = [
    "scan_page_server_action_wiring",
    "forbidden_package_items_zero",
    "forbidden_returns_from_zero",
    "forbidden_products_insert_zero",
    "no_direct_browser_writes_item_scan",
    "operator_mobile_tree_no_package_items",
    "operator_mobile_tree_no_products_insert",
    "env_credentials",
    "live_package_items_absent",
    "fixture_slip_contents",
    "fixture_return_items_hydrate",
    "client_resolve_sample_fnsku",
  ];
  report.pass = critical.every((name) => steps.find((s) => s.step === name)?.ok);

  writeArtifacts(outDir, runId, steps, report, wiring, forbidden, {
    slip_count: slipRows?.length ?? 0,
    return_item_count: retRows?.length ?? 0,
    fnsku_match: fnskuOutcome.kind,
  });

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

function writeArtifacts(
  outDir: string,
  runId: string,
  steps: Step[],
  report: Record<string, unknown>,
  wiring: Record<string, boolean | number>,
  forbidden: ReturnType<typeof scanForbiddenInSurface>,
  dbSmoke: { slip_count: number; return_item_count: number; fnsku_match: string } | null,
): void {
  mkdirSync(outDir, { recursive: true });

  const pass = Boolean(report.pass);
  const failed = steps.filter((s) => !s.ok);

  writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit: "scanner-neda-10-mobile-wire-to-server-actions",
        run_id: runId,
        date: "2026-05-18",
        goal: "Wire operator-mobile BOX item scan UI to v165 server actions",
        contract: "scanner-backend-contract-sync-v165/run-20260518-001",
        prerequisite: "scanner-neda-08-final-ui-signoff/run-20260518-001",
        fixture_package_id: FIXTURE_PACKAGE_ID,
        constraints: ["no migrations", "no DB contract changes", "preserve Neda UI layout"],
        e2e_result: pass ? "pass" : "fail",
        script: "scripts/scanner-neda-10-mobile-wire-to-server-actions.ts",
        artifacts: [
          "manifest.json",
          "wiring-summary.md",
          "smoke-result.md",
          "forbidden-contract-scan.md",
          "validation-results.md",
          "probe-output.json",
          "blockers.md",
          "next-step-recommendation.md",
        ],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(outDir, "wiring-summary.md"),
    `# Wiring summary — SCANNER-NEDA-10

**Run:** \`${runId}\`  
**Scan page:** \`app/scanner/operator-mobile/scan/page.tsx\`

## Server actions (P0)

| Action | UI binding |
|--------|------------|
| \`listOperatorSlipContentsForPackageAction\` | \`itemInspectionSlipLines\` effect (flowPhase \`items\`); slip order/conflict refresh on package_scan |
| \`listOperatorPackageItemsForPackageAction\` | Hydrate \`packageItemScanState\` via \`aggregateOperatorPackageItemRows\` on mount/reload (\`packageItemsHydrationNonce\`) |
| \`insertOperatorPackageItemAction\` | \`saveItemUnitModal\` on modal save |

## Client resolver

| Helper | Usage |
|--------|--------|
| \`resolveItemBarcodeAgainstSlipRows\` | \`handleItemBarcodeScan\`, \`saveItemUnitModal\` (re-match when preset null) |

## Static wiring gates

\`\`\`json
${JSON.stringify(wiring, null, 2)}
\`\`\`

## Save sequence (contract)

1. Scan → \`resolveItemBarcodeAgainstSlipRows\` → unit modal  
2. Save → \`insertOperatorPackageItemAction\`  
3. Success → \`setPackageItemsHydrationNonce(n+1)\` → re-fetch \`listOperatorPackageItemsForPackageAction\`

## UI preservation

- Sticky items header, compact slip rows, progressive white→green via \`itemInspectionSlipLinePresentation\` — unchanged.
`,
  );

  writeFileSync(
    join(outDir, "smoke-result.md"),
    `# Smoke result — read-only DB + resolver

**Fixture package:** \`${FIXTURE_PACKAGE_ID}\`

| Check | Result |
|-------|--------|
| Slip lines (≥2) | ${dbSmoke ? (dbSmoke.slip_count >= 2 ? "**Pass**" : "**Fail**") : "_skipped (no env)_"} — ${dbSmoke?.slip_count ?? "n/a"} rows |
| return_items hydrate | ${dbSmoke ? (dbSmoke.return_item_count > 0 ? "**Pass**" : "**Fail**") : "_skipped_"} — ${dbSmoke?.return_item_count ?? "n/a"} rows |
| FNSKU \`${SAMPLE_FNSKU}\` resolve | ${dbSmoke ? `**${dbSmoke.fnsku_match === "single" ? "Pass" : "Fail"}** (${dbSmoke.fnsku_match})` : "_skipped_"} |
| NEDA-06 smoke row | ${report.neda_06_row_present ? "present" : "not found (optional)"} |

**Overall smoke:** ${pass ? "**PASS**" : "**FAIL**"}
`,
  );

  writeFileSync(
    join(outDir, "forbidden-contract-scan.md"),
    `# Forbidden contract scan — operator-mobile item-scan surface

**Surface files:**
${ITEM_SCAN_SURFACE.map((f) => `- \`${f}\``).join("\n")}

| Forbidden pattern | Hits |
|-------------------|------|
| \`package_items\` | ${forbidden.package_items.length} |
| \`.from("returns")\` | ${forbidden.returns_from.length} |
| \`products.insert\` | ${forbidden.products_insert.length} |
| Direct browser Supabase writes (scan page item path) | ${forbidden.browser_writes.length} |

**Operator-mobile tree \`package_items\` refs:** ${(report.operator_mobile_tree as { package_items_refs: string[] })?.package_items_refs?.length ?? 0}

**Verdict:** ${forbidden.package_items.length === 0 && forbidden.returns_from.length === 0 && forbidden.products_insert.length === 0 ? "**PASS** — zero forbidden usage in item-scan surface" : "**FAIL** — see probe-output.json"}
`,
  );

  writeFileSync(
    join(outDir, "validation-results.md"),
    `# Validation results

| # | Step | Pass |
|---|------|------|
${steps.map((s, i) => `| ${i + 1} | ${s.step} | ${s.ok ? "✅" : "❌"} ${s.detail.slice(0, 80)} |`).join("\n")}

**Summary:** ${pass ? "**PASS**" : `**FAIL** (${failed.length} step(s))`}
`,
  );

  writeFileSync(
    join(outDir, "blockers.md"),
    `# Blockers

${pass ? "**None** for NEDA-10 mobile wire-to-server-actions." : failed.map((f) => `- **${f.step}:** ${f.detail}`).join("\n")}

_Note: EP-path \`operatorReceiveItem\` remains for tracking/expected-package flows; BOX slip scan uses \`insertOperatorPackageItemAction\` only (per v165 contract)._
`,
  );

  writeFileSync(
    join(outDir, "next-step-recommendation.md"),
    `# Next step recommendation

${pass
  ? `1. **Operator session spot-check** — One matched FNSKU save on \`/scanner/operator-mobile/scan\` with live cookies (confirms RLS on \`insertOperatorPackageItemAction\`).
2. **Staging clone (ENV-06)** — Re-run this script against staging after contract clone.
3. **Optional** — Extend \`listOperatorPackageItemsForPackageAction\` select with product_match_status if mismatch chips on slip cards are required (additive read only).`
  : `1. Fix failing gates in \`validation-results.md\`.
2. Re-run: \`npx tsx scripts/scanner-neda-10-mobile-wire-to-server-actions.ts\`
3. Re-run: \`npx tsc --noEmit\``}
`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
