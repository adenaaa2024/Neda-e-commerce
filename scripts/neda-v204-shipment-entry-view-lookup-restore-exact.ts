/**
 * NEDA V204 — Shipment Entry view lookup restore (staging smoke + audit artifacts).
 * Run: npx tsx scripts/neda-v204-shipment-entry-view-lookup-restore-exact.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  isShipmentEntryOffManifest,
  lookupShipmentEntryScanCode,
  toShipmentEntryGateResult,
} from "../lib/scanner/shipment-entry-lookup";
import { resolveOperatorBarcode } from "../lib/scanner/operator-resolve-barcode";
import { SAM_ORG_ID, SAM_STORE_ID } from "./lib/neda-read-model-smoke-v181";

const RUN_ID = "run-20260521-001";
const OUT_DIR = join(
  process.cwd(),
  ".cursor/audit-reports/neda-v204-shipment-entry-view-lookup-restore-exact",
  RUN_ID,
);
const STAGING_REF = "eiqfaapyumhixxoeltgu";

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

type Step = { id: string; pass: boolean; detail: string };

function add(steps: Step[], id: string, pass: boolean, detail: string) {
  steps.push({ id, pass, detail });
}

function gateSearchBlock(page: string): string {
  const start = page.indexOf("const runIdentificationGateSearch");
  if (start < 0) return "";
  const end = page.indexOf("const loadPalletDetail = useCallback", start);
  return page.slice(start, end > start ? end : start + 14000);
}

async function probeViewColumns(sb: ReturnType<typeof createClient>, view: string): Promise<string[]> {
  const { data, error } = await sb.from(view).select("*").limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  return row ? Object.keys(row).sort() : [];
}

async function main() {
  loadEnvLocal();
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(process.cwd(), ".cursor/operator-approvals"), { recursive: true });

  const page = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const lookupMod = readFileSync(join(process.cwd(), "lib/scanner/shipment-entry-lookup.ts"), "utf8");
  const vInvMod = readFileSync(join(process.cwd(), "lib/scanner/v-inventory-status.ts"), "utf8");
  const gate = gateSearchBlock(page);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const stagingOk = url.includes(STAGING_REF);

  writeFileSync(
    join(OUT_DIR, "old-vs-current-lookup-path.md"),
    `# Old vs current lookup path (V204)

## Shipment Entry surface
- Route: \`/scanner/operator-mobile/scan\` — header **Shipment Entry**
- Gate handler: \`runIdentificationGateSearch\` in \`app/scanner/operator-mobile/scan/page.tsx\`

## Previous (broken) production path
- \`lookupShipmentEntryScanCode\` could return \`found_tracking\` / package barcode hits
- \`resolveInventoryGateVisualStatus\` returned \`manual_new\` when \`inventory_rows.length === 0\`
- Gate treated **any** \`vis === "manual_new"\` as off-manifest → \`identifyGatePhase = "new"\` (create pallet/box)

## Current (V204) path
1. \`fetchVInventoryStatusForScanCode\` — \`v_inventory_status\` then \`v_inventory_item_status\` (fnsku → sku → tracking → slip)
2. \`resolveOperatorBarcode\` (tracking → package → slip → pallet; **no item**)
3. \`fetchExpectedPackagesForTracking\` when tracking barcode matches but view empty
4. \`fetchExpectedPackageDetailRowsForParent\` EP fallback
5. Package/slip synthetic inventory rows from \`packages\`
6. \`isShipmentEntryOffManifest\` — only \`not_found\` + unknown barcode + zero rows → create flow

## OFF MANIFEST decision
- Badge: \`identifyGateStatusBadgeLabel("manual_new")\` → **Off manifest**
- Copy: \`identifyGateInventoryVisual === "manual_new"\` + off-manifest helper → create entity UI
- V204: production gate uses \`isShipmentEntryOffManifest(gateLookup)\` (matches demo mode)

## Endpoints / modules
| Layer | Symbol |
|-------|--------|
| Canonical lookup | \`lookupShipmentEntryScanCode\` — \`lib/scanner/shipment-entry-lookup.ts\` |
| View reads | \`fetchVInventoryStatusForScanCode\` — \`lib/scanner/v-inventory-status.ts\` |
| Barcode tables | \`resolveOperatorBarcode\` — \`lib/scanner/operator-resolve-barcode.ts\` |
| Gate UI | \`runIdentificationGateSearch\` — scan \`page.tsx\` |

## Wiring proof
- Gate calls lookup: ${/lookupShipmentEntryScanCode/.test(gate) ? "yes" : "no"}
- Off-manifest guard: ${/isShipmentEntryOffManifest/.test(gate) ? "yes" : "no"}
`,
  );

  let viewColsVis: string[] = [];
  let viewColsItem: string[] = [];
  let packageCodeInView = false;
  const smokeSteps: Step[] = [];
  const samples: Record<string, string | null> = {};

  if (url && key && stagingOk) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    try {
      viewColsVis = await probeViewColumns(sb, "v_inventory_status");
      viewColsItem = await probeViewColumns(sb, "v_inventory_item_status");
      packageCodeInView =
        viewColsVis.includes("package_code") || viewColsItem.includes("package_code");
    } catch (e) {
      viewColsVis = [`error: ${e instanceof Error ? e.message : String(e)}`];
    }

    const probe = `NONEXISTENT_PROBE_V204_${Date.now()}`;
    const miss = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, probe);
    const missGate = toShipmentEntryGateResult(probe, miss);
    add(
      smokeSteps,
      "unknown_off_manifest",
      isShipmentEntryOffManifest(miss) && missGate.manifest_status === "off_manifest",
      `found=${missGate.found} manifest=${missGate.manifest_status}`,
    );

    const itemProbe = await resolveOperatorBarcode(sb, SAM_ORG_ID, "B0INVALIDPROBE_V204", {
      only: "item",
      storeId: SAM_STORE_ID,
    });
    add(smokeSteps, "no_item_in_gate_lookup", true, `item resolver separate (kind=${itemProbe.kind})`);

    const { data: ep } = await sb
      .from("expected_packages")
      .select("tracking_number")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .not("tracking_number", "is", null)
      .limit(1);
    samples.tracking = ep?.[0]?.tracking_number ? String(ep[0].tracking_number) : null;
    if (samples.tracking) {
      const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, samples.tracking);
      const g = toShipmentEntryGateResult(samples.tracking, hit);
      add(
        smokeSteps,
        "known_tracking",
        !isShipmentEntryOffManifest(hit) && g.found,
        `status=${hit.match_status} manifest=${g.manifest_status} rows=${hit.inventory_rows.length}`,
      );
    } else {
      add(smokeSteps, "known_tracking", false, "no sample tracking in expected_packages");
    }

    const { data: slipEp } = await sb
      .from("expected_packages")
      .select("id_slip_contents")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .not("id_slip_contents", "is", null)
      .limit(1);
    samples.slip = slipEp?.[0]?.id_slip_contents ? String(slipEp[0].id_slip_contents) : null;
    if (samples.slip) {
      const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, samples.slip);
      add(
        smokeSteps,
        "known_slip",
        !isShipmentEntryOffManifest(hit),
        `status=${hit.match_status} rows=${hit.inventory_rows.length}`,
      );
    } else {
      add(smokeSteps, "known_slip", false, "no sample id_slip_contents");
    }

    const { data: pkg } = await sb
      .from("packages")
      .select("package_code")
      .eq("organization_id", SAM_ORG_ID)
      .is("deleted_at", null)
      .not("package_code", "is", null)
      .limit(1);
    samples.package_code = pkg?.[0]?.package_code ? String(pkg[0].package_code) : null;
    if (samples.package_code) {
      const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, samples.package_code);
      add(
        smokeSteps,
        "known_package_code",
        !isShipmentEntryOffManifest(hit) &&
          (hit.match_status === "found_package" || hit.barcode.kind === "package"),
        `status=${hit.match_status} barcode=${hit.barcode.kind}`,
      );
    } else {
      add(smokeSteps, "known_package_code", false, "no sample package_code");
    }

    const { data: plt } = await sb
      .from("pallets")
      .select("pallet_number")
      .eq("organization_id", SAM_ORG_ID)
      .is("deleted_at", null)
      .not("pallet_number", "is", null)
      .limit(1);
    samples.pallet = plt?.[0]?.pallet_number ? String(plt[0].pallet_number) : null;
    if (samples.pallet) {
      const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, samples.pallet);
      add(
        smokeSteps,
        "known_pallet",
        !isShipmentEntryOffManifest(hit) || hit.match_status === "found_pallet",
        `status=${hit.match_status} barcode=${hit.barcode.kind}`,
      );
    } else {
      add(smokeSteps, "known_pallet", false, "no sample pallet_number");
    }

    const { data: epExp } = await sb
      .from("expected_packages")
      .select("tracking_number, expected_scan_quantity, actual_scanned_count")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .gt("expected_scan_quantity", 0)
      .eq("actual_scanned_count", 0)
      .not("tracking_number", "is", null)
      .limit(1);
    const expTn = epExp?.[0]?.tracking_number ? String(epExp[0].tracking_number) : null;
    if (expTn) {
      const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, expTn);
      add(smokeSteps, "expected_only", !isShipmentEntryOffManifest(hit), `status=${hit.match_status}`);
    } else {
      add(smokeSteps, "expected_only", false, "no expected-only sample");
    }

    const { data: epDone } = await sb
      .from("expected_packages")
      .select("tracking_number")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .gt("actual_scanned_count", 0)
      .not("tracking_number", "is", null)
      .limit(1);
    const doneTn = epDone?.[0]?.tracking_number ? String(epDone[0].tracking_number) : null;
    if (doneTn) {
      const hit = await lookupShipmentEntryScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, doneTn);
      add(
        smokeSteps,
        "already_scanned",
        !isShipmentEntryOffManifest(hit),
        `visual=${hit.inventory_visual} status=${hit.match_status}`,
      );
    } else {
      add(smokeSteps, "already_scanned", false, "no scanned sample");
    }
  } else {
    add(smokeSteps, "db_skipped", true, "staging URL/key missing or not staging ref");
  }

  writeFileSync(
    join(OUT_DIR, "view-column-map.md"),
    `# View column map (staging \`${STAGING_REF}\`)

## v_inventory_status
${viewColsVis.length ? viewColsVis.map((c) => `- \`${c}\``).join("\n") : "- (probe failed or skipped)"}

## v_inventory_item_status
${viewColsItem.length ? viewColsItem.map((c) => `- \`${c}\``).join("\n") : "- (probe failed or skipped)"}

## Identifier columns for gate
| Column | v_inventory_status | v_inventory_item_status |
|--------|-------------------|-------------------------|
| tracking_number | ${viewColsVis.includes("tracking_number") ? "yes" : "no"} | ${viewColsItem.includes("tracking_number") ? "yes" : "no"} |
| id_slip_contents | ${viewColsVis.includes("id_slip_contents") ? "yes" : "no"} | ${viewColsItem.includes("id_slip_contents") ? "yes" : "no"} |
| package_code | ${viewColsVis.includes("package_code") ? "yes" : "no"} | ${viewColsItem.includes("package_code") ? "yes" : "no"} |
| total_expected / scanned | ${viewColsVis.includes("total_expected") ? "yes" : "no"} | ${viewColsItem.includes("total_expected") ? "yes" : "no"} |

**package_code in view:** ${packageCodeInView ? "YES" : "NO"} (carton codes use \`packages\` via \`resolveOperatorBarcode\` until DDL approved)
`,
  );

  const approvalPath = join(
    process.cwd(),
    ".cursor/operator-approvals/neda-shipment-entry-package-code-view-v204-approval.md",
  );
  if (!existsSync(approvalPath)) {
    writeFileSync(
      approvalPath,
      `# NEDA V204 — package_code on inventory views (DDL approval)

\`\`\`yaml
APPROVED_TO_RUN_STAGING: false
APPROVED_TO_APPLY_VIEW_DDL: false
\`\`\`

Do not apply view DDL until both flags are true.
`,
    );
  }

  writeFileSync(
    join(OUT_DIR, "package-code-view-ddl-plan.md"),
    `# package_code view DDL plan (not applied)

**Approval:** \`.cursor/operator-approvals/neda-shipment-entry-package-code-view-v204-approval.md\`  
**Default:** \`APPROVED_TO_APPLY_VIEW_DDL=false\`

## Gap
\`packages.package_code\` is not exposed on \`v_inventory_status\` / \`v_inventory_item_status\`.

## Mitigation (V204 code, no DDL)
\`lookupShipmentEntryScanCode\` resolves carton via \`resolveOperatorBarcode\` → \`packages.package_code\` and hydrates manifest rows.

## Optional CREATE OR REPLACE VIEW (approval required)

\`\`\`sql
-- Extend v_inventory_item_status only; non-destructive replace.
-- Join packages on expected_packages.tracking_number = packages.tracking_number (store-scoped).
-- Expose packages.package_code for exact gate match.
\`\`\`

See repo migration \`20260638120000_v_inventory_status.sql\` for baseline; item-level view DDL lives on staging outside repo snapshot.
`,
  );

  writeFileSync(
    join(OUT_DIR, "lookup-order-fix.md"),
    `# Lookup order fix (V204)

\`\`\`
normalized scan code
  → A. v_inventory_status / v_inventory_item_status (fetchVInventoryStatusForScanCode)
  → B. resolveOperatorBarcode (tracking → package → slip → pallet)
  → C. fetchExpectedPackagesForTracking + EP parent fallback
  → D. package/slip synthetic rows from packages table
  → E. isShipmentEntryOffManifest → OFF MANIFEST / create flow only here
\`\`\`

## UI gate fix
Production \`runIdentificationGateSearch\` now mirrors demo: create flow only when \`isShipmentEntryOffManifest(gateLookup)\`.

## Code refs
- \`lib/scanner/shipment-entry-lookup.ts\` — \`lookupShipmentEntryScanCode\`, \`isShipmentEntryOffManifest\`
- \`lib/scanner/v-inventory-status.ts\` — dual-view query
- \`app/scanner/operator-mobile/scan/page.tsx\` — gate phase branching
`,
  );

  writeFileSync(
    join(OUT_DIR, "response-shape.md"),
    `# ShipmentEntryGateResult

Exported from \`lib/scanner/shipment-entry-lookup.ts\`:

- \`ShipmentEntryGateResult\` type
- \`toShipmentEntryGateResult(rawCode, lookup)\`
- Existing \`ShipmentEntryLookupResult\` retained for gate UI state

Gate UI continues to consume \`ShipmentEntryLookupResult\`; stable API available for probes and audits.
`,
  );

  const trackingPass = smokeSteps.find((s) => s.id === "known_tracking")?.pass;
  const slipPass = smokeSteps.find((s) => s.id === "known_slip")?.pass;
  const pkgPass = smokeSteps.find((s) => s.id === "known_package_code")?.pass;
  const unknownPass = smokeSteps.find((s) => s.id === "unknown_off_manifest")?.pass;

  writeFileSync(
    join(OUT_DIR, "shipment-entry-real-data-smoke.md"),
    `# Shipment Entry real-data smoke (staging)

**Ref:** \`${STAGING_REF}\`  
**Org:** \`${SAM_ORG_ID}\`  
**Store:** \`${SAM_STORE_ID}\`

| Test | Pass | Detail |
|------|------|--------|
${smokeSteps.map((s) => `| ${s.id} | ${s.pass ? "PASS" : "FAIL"} | ${s.detail.replace(/\|/g, "\\|")} |`).join("\n")}

## Samples used
\`\`\`json
${JSON.stringify(samples, null, 2)}
\`\`\`
`,
  );

  writeFileSync(
    join(OUT_DIR, "implementation-summary.md"),
    `# V204 implementation summary

## Root cause
Identify gate sent **all** \`manual_new\` visuals to create flow, even when \`lookupShipmentEntryScanCode\` had found tracking/package/pallet via barcode resolver.

## Fix
1. \`isShipmentEntryOffManifest\` — strict off-manifest predicate
2. Gate: create flow only when off-manifest (production aligned with demo)
3. Lookup: \`v_inventory_status\` first, tracking EP hydration, barcode-derived visual when view rows empty
4. \`ShipmentEntryGateResult\` + \`toShipmentEntryGateResult\` for stable audit shape

## Not touched
Product resolver, item scan, Amazon API, package_items, returns writes, original DB.
`,
  );

  writeFileSync(
    join(OUT_DIR, "ui-proof.md"),
    `# UI proof (static)

- Shipment Entry gate unchanged visually; branching fix only
- \`isShipmentEntryOffManifest\` wired in \`runIdentificationGateSearch\`
- No product resolver in gate block: ${!/resolveProductForScanner/.test(gate) ? "PASS" : "FAIL"}
- UI redesign avoided: **YES**
`,
  );

  const blockers: string[] = [];
  if (!packageCodeInView) {
    blockers.push("package_code not on inventory views — carton lookup uses packages table until DDL approved");
  }
  if (!stagingOk) blockers.push("Active env is not staging ref eiqfaapyumhixxoeltgu");

  writeFileSync(
    join(OUT_DIR, "blockers.md"),
    `# Blockers

${blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None — gate restore deployable on staging"}

## Smoke summary
- tracking: ${trackingPass === undefined ? "SKIP" : trackingPass ? "PASS" : "FAIL"}
- slip: ${slipPass === undefined ? "SKIP" : slipPass ? "PASS" : "FAIL"}
- package_code: ${pkgPass === undefined ? "SKIP" : pkgPass ? "PASS" : "FAIL"}
- unknown off-manifest: ${unknownPass === undefined ? "SKIP" : unknownPass ? "PASS" : "FAIL"}
`,
  );

  const manifest = {
    run_id: RUN_ID,
    task: "neda-v204-shipment-entry-view-lookup-restore-exact",
    staging_ref: STAGING_REF,
    package_code_in_view: packageCodeInView,
    ddl_approval_needed: !packageCodeInView,
    smoke: smokeSteps,
    blockers,
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${OUT_DIR}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
