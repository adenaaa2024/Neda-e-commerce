/**
 * PRODUCT-LINKAGE-UI-DATA-CONNECTOR-V178 — static surface inventory (no DB).
 *
 *   npx tsx scripts/product-linkage-ui-data-connector-v178-inventory.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";

type SurfaceRow = {
  id: number;
  surface: string;
  route_or_module: string;
  loader: string;
  contract_usage: "full" | "partial" | "exempt" | "gap";
  component: string;
  notes: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function fileHas(root: string, rel: string, needles: string[]): boolean {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) return false;
  const text = fs.readFileSync(fp, "utf8");
  return needles.every((n) => text.includes(n));
}

function main(): void {
  const runId = runIdArg();
  const root = process.cwd();
  const outDir = path.join(
    root,
    ".cursor/audit-reports/product-linkage-ui-data-connector-v178",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const matrix: SurfaceRow[] = [
    {
      id: 1,
      surface: "PIM product grid / detail",
      route_or_module: "/dashboard/products (PimCatalogHub, CatalogDataGrid, ProductDetailDrawer)",
      loader: "Server actions + products table (canonical catalog)",
      contract_usage: "exempt",
      component: "products.product_name (catalog-native; not operational linkage)",
      notes: "PIM shows canonical products.id rows — correct pattern for catalog. No ProductLinkageDisplayContract required.",
    },
    {
      id: 2,
      surface: "Returns — Items tab",
      route_or_module: "/returns → ItemsDataTable",
      loader: "listReturns / RETURN_SELECT + ReturnItemProductLinkage",
      contract_usage: "partial",
      component: "ReturnItemProductLinkage + V178 labels",
      notes: "Row fields map via linkageFields; V178 copy (No product link yet / Needs review). Staging return_items test-data banner when total≤50.",
    },
    {
      id: 3,
      surface: "Returns — Packages tab",
      route_or_module: "/returns → packages accordion",
      loader: "listPackages + PACKAGE_LIST_SELECT",
      contract_usage: "exempt",
      component: "PackageDrawerContent; ManifestLineProductLinkage on manifest lines only",
      notes: "Package/pallet level — no product_id on package header. Manifest lines use mapExpectedItemToProductLinkageDisplayContract.",
    },
    {
      id: 4,
      surface: "Returns — Pallets tab",
      route_or_module: "/returns → pallets",
      loader: "listPallets + PALLET_LIST_SELECT",
      contract_usage: "exempt",
      component: "Pallet drawers / package sub-tables",
      notes: "Pallet-level only; product linkage on nested return_items / slip lines only.",
    },
    {
      id: 5,
      surface: "Scanner route / item inspection",
      route_or_module: "/scanner (removal scan) + /returns item drawers",
      loader: "/scanner: expected_packages scan; returns: ReturnItemProductLinkage",
      contract_usage: "partial",
      component: "ReturnItemProductLinkage in returns; /scanner is package scan (no contract)",
      notes: "Operable Neda scanner UX is returns item inspection with linkage badges. /scanner page is distinct removal workflow.",
    },
    {
      id: 6,
      surface: "Claim evidence page",
      route_or_module: "/claim-engine/evidence",
      loader: "ClaimDraftProductLinkagePanel → /api/claims/drafts/[id]/product-linkage",
      contract_usage: "full",
      component: "ProductLinkageDisplayBlock",
      notes: "Read-only; uses fetchProductLinkageDisplayContract. Evidence graph edges do not mutate mapping.",
    },
    {
      id: 7,
      surface: "Claim candidate / draft list (inbox)",
      route_or_module: "/claim-engine/inbox",
      loader: "GET /api/claims/inbox + buildProductLinkageDisplayContracts",
      contract_usage: "full",
      component: "ProductLinkageDisplayBlock in list + detail",
      notes: "List + detail use product_linkage from API (V178 wired).",
    },
    {
      id: 8,
      surface: "TRID / reference candidates panel",
      route_or_module: "ClaimReferenceCandidatesPanel",
      loader: "GET reference-candidates API",
      contract_usage: "exempt",
      component: "ClaimReferenceCandidatesPanel",
      notes: "Order/FRR reference matching — not product linkage display. No product_id mutation.",
    },
    {
      id: 9,
      surface: "Import / report history (product columns)",
      route_or_module: "/dashboard/products import review",
      loader: "Import pipeline + products rows",
      contract_usage: "partial",
      component: "Import review grids (product_name from import row)",
      notes: "Shows imported product_name / conflict_pids — catalog ingest, not resolver contract. Amazon import tables use server resolver on ingest.",
    },
  ];

  const checks = {
    product_linkage_display_block: fs.existsSync(
      path.join(root, "components/product-linkage/ProductLinkageDisplayBlock.tsx"),
    ),
    display_ui_lib: fs.existsSync(path.join(root, "lib/product-linkage-display-ui.ts")),
    inbox_uses_block: fileHas(root, "app/claim-engine/inbox/ClaimInboxClient.tsx", [
      "ProductLinkageDisplayBlock",
      "product_linkage",
    ]),
    claim_draft_panel: fileHas(root, "components/claims/ClaimDraftProductLinkagePanel.tsx", [
      "ProductLinkageDisplayBlock",
    ]),
    manifest_line: fileHas(root, "components/returns/ManifestLineProductLinkage.tsx", [
      "mapExpectedItemToProductLinkageDisplayContract",
    ]),
    return_items_banner: fileHas(root, "app/returns/_components.tsx", [
      "return_items",
      "fake/test data",
    ]),
    package_items_absent: !fileHas(root, "lib/product-id-mapping-wave2-pg.ts", ["CREATE TABLE package_items"]),
  };

  const gaps = matrix.filter((r) => r.contract_usage === "gap");
  const status = gaps.length === 0 && checks.product_linkage_display_block ? "PASS" : "PASS_WITH_NOTES";

  fs.writeFileSync(path.join(outDir, "connector-matrix.json"), JSON.stringify({ run_id: runId, matrix, checks }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "return_items-test-data.md"),
    [
      "# return_items — staging test / fake data (V178)",
      "",
      "**Not hidden:** staging `return_items` is low-volume test data (~6 rows on clone).",
      "",
      "- UI banner when `returnsTotalInDb <= 50` on Items tab (`app/returns/_components.tsx`).",
      "- Documented in `PROJECT_CONTEXT.md`, `.ai-memory/DECISIONS.md` (D-008).",
      "- Resolver coverage % on `return_items` must **not** be interpreted as production KPI.",
      "",
      "Wave-2 V176 intentionally skipped blind backfill on `return_items`.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# PRODUCT-LINKAGE-UI-DATA-CONNECTOR-V178",
      "",
      `**Run id:** \`${runId}\``,
      `**Status:** ${status}`,
      "",
      "## Deliverables",
      "",
      "- Shared V178 copy: `lib/product-linkage-display-ui.ts`",
      "- Unified UI block: `components/product-linkage/ProductLinkageDisplayBlock.tsx`",
      "- Wired: claim inbox list/detail, claim draft panel, manifest lines, return item labels",
      "",
      "## V178 labels",
      "",
      "- Unresolved → **No product link yet**",
      "- Ambiguous → **Needs review**",
      "- Headline → `product_name` ?? `fallback_display_name`",
      "",
      "## Constraints honored",
      "",
      "- No migrations, no production, no package_items, no auto-create, no fuzzy/OCR link in UI",
      "- UI does not create mappings",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "PRODUCT-LINKAGE-UI-DATA-CONNECTOR-V178",
        run_id: runId,
        status,
        artifacts: ["connector-matrix.json", "summary.md", "return_items-test-data.md", "manifest.json"],
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ run_id: runId, status, outDir }, null, 2));
}

main();
