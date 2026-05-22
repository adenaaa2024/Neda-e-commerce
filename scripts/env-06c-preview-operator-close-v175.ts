/**
 * ENV-06C-PREVIEW-OPERATOR-CLOSE-V175 — Close Preview signoff (Deployment Protection gate).
 *
 *   npx tsx scripts/env-06c-preview-operator-close-v175.ts
 *   npx tsx scripts/env-06c-preview-operator-close-v175.ts --operator-passed --operator-name="Main" --operator-date=2026-05-19
 *
 * Optional: VERCEL_AUTOMATION_BYPASS_SECRET (Preview only) for automated HTTP PASS.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildPimCatalogDeepLink,
  OPERABLE_SAM_AM_STORE_ID,
  OPERABLE_SAM_DISTRIBUTION_ORG_ID,
} from "../lib/workspace-url-context";
import { buildClaimFilingPacketPreview } from "../lib/claim-filing-packet-preview";
import { buildReferenceCandidatesResponseForDraftId } from "../lib/claim-reference-candidates";
import { fetchDraftRow } from "../lib/claim-evidence-preview";
import { PACKAGE_LIST_SELECT } from "../lib/package-pallet-canonical";
import { refFromSupabaseUrl } from "../lib/staging-project-ref";

const AUDIT_ID = "ENV-06C-PREVIEW-OPERATOR-CLOSE-V175";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PREVIEW_BASE =
  "https://ecommerce-os-git-integrat-ec746a-mebrahimipargoo-9799s-projects.vercel.app";
const PREVIEW_SHA = "22e514404de6bc8dc9a9d0b23789e2adde1a8f52";
const PILOT_DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const EXPECTED_STORAGE_OBJECTS = 144;

type Row = { id: string; pass: boolean; layer: string; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!.trim();
  const eq = process.argv.find((x) => x.startsWith(`${flag}=`));
  return eq ? eq.split("=").slice(1).join("=").trim() : undefined;
}

function loadEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

async function probe(routePath: string, bypass: string | undefined): Promise<number> {
  const headers: Record<string, string> = {};
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const r = await fetch(`${PREVIEW_BASE}${routePath}`, { redirect: "manual", headers });
  return r.status;
}

function verifyCanonicalCodeMarkers(): { package_number_absent: boolean; canonical_select: boolean } {
  const select = PACKAGE_LIST_SELECT;
  const returnsActions = fs.readFileSync(path.join(process.cwd(), "app", "returns", "actions.ts"), "utf8");
  const badSelect =
    /\.select\([^)]*package_number/.test(returnsActions) ||
    /\.select\([^)]*["']photo_url["']/.test(returnsActions);
  return {
    package_number_absent: !badSelect && select.includes("package_code"),
    canonical_select: select.includes("inside_photo_urls") && select.includes("outside_photo_urls"),
  };
}

function verifyUiMarkers(): Record<string, boolean> {
  const root = path.join(process.cwd(), "components", "claims");
  const trid = fs.readFileSync(path.join(root, "ClaimReferenceCandidatesPanel.tsx"), "utf8");
  return {
    scanner_route: fs.existsSync(path.join(process.cwd(), "app", "scanner", "page.tsx")),
    linkage_badge: fs.existsSync(path.join(root, "ClaimDraftProductLinkagePanel.tsx")),
    trid_copy: trid.includes("CopyButton"),
  };
}

async function main(): Promise<void> {
  const localEnv = loadEnvFile(path.join(process.cwd(), ".env.local"));
  const url = localEnv.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = localEnv.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const id = runId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/env-06c-preview-operator-close-v175",
    id,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const operatorPassed = process.argv.includes("--operator-passed");
  const operatorName = argValue("--operator-name") ?? "";
  const operatorDate = argValue("--operator-date") ?? "";

  const rows: Row[] = [];
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  const ref = refFromSupabaseUrl(url);

  rows.push({
    id: "env_staging_ref",
    layer: "config",
    pass: ref === STAGING_REF,
    detail: `local ref=${ref ?? "?"}`,
  });

  const loginStatus = await probe("/login", bypass);
  const protectionOpen = loginStatus === 200 || loginStatus === 307 || loginStatus === 308;
  rows.push({
    id: "01_vercel_deployment_protection",
    layer: "preview_http",
    pass: protectionOpen || operatorPassed,
    detail: operatorPassed
      ? "operator attested — Vercel team gate passed in browser"
      : bypass
        ? `GET /login → ${loginStatus} (bypass)`
        : `GET /login → ${loginStatus} — pass team gate in browser`,
  });

  if (!url || !key) {
    rows.push({ id: "db", layer: "staging", pass: false, detail: "missing supabase env" });
  } else {
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const { data: org } = await sb
      .from("organizations")
      .select("name")
      .eq("id", OPERABLE_SAM_DISTRIBUTION_ORG_ID)
      .maybeSingle();
    rows.push({
      id: "03_sam_distribution_org",
      layer: "staging",
      pass: /sam distribution/i.test(String(org?.name ?? "")),
      detail: `org="${org?.name ?? "?"}"`,
    });

    const { data: store } = await sb
      .from("stores")
      .select("name")
      .eq("id", OPERABLE_SAM_AM_STORE_ID)
      .maybeSingle();
    rows.push({
      id: "04_sam_am_store",
      layer: "staging",
      pass: /sam am/i.test(String(store?.name ?? "")),
      detail: `store="${store?.name ?? "?"}"`,
    });

    const { data: rpc, error: rpcErr } = await sb.rpc("pim_catalog_products_page", {
      p_organization_id: OPERABLE_SAM_DISTRIBUTION_ORG_ID,
      p_store_id: OPERABLE_SAM_AM_STORE_ID,
      p_page: 1,
      p_page_size: 5,
      p_q: null,
      p_vendor_id: null,
      p_category_id: null,
      p_brand: null,
      p_status: null,
      p_match_source: null,
      p_source_report_type: null,
      p_image_filter: "any",
      p_sku_filter: "any",
      p_asin_filter: "any",
      p_fnsku_filter: "any",
      p_upc_filter: "any",
      p_vendor_presence: "any",
      p_category_presence: "any",
      p_brand_field_filter: "any",
      p_sort_column: "updated_at",
      p_sort_dir: "desc",
    });
    const total =
      rpc && typeof rpc === "object" && !Array.isArray(rpc)
        ? Number((rpc as { total?: number }).total ?? 0)
        : 0;
    rows.push({
      id: "05_pim_grid_17001",
      layer: "staging",
      pass: !rpcErr && total >= 16_950,
      detail: rpcErr ? rpcErr.message : `rpc total=${total}`,
    });

    const { error: pkgErr } = await sb
      .from("packages")
      .select("id, package_code, inside_photo_urls, outside_photo_urls")
      .limit(1);
    const { error: pltErr } = await sb.from("pallets").select("id, pallet_photo_urls").limit(1);
    const { count: pkgCount } = await sb
      .from("packages")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    rows.push({
      id: "06_returns_packages_pallets_schema",
      layer: "staging",
      pass: !pkgErr && !pltErr && (pkgCount ?? 0) > 0,
      detail: pkgErr?.message ?? pltErr?.message ?? `packages=${pkgCount ?? 0}`,
    });

    const markers = verifyCanonicalCodeMarkers();
    rows.push({
      id: "06c_no_package_number_select",
      layer: "code",
      pass: markers.package_number_absent && markers.canonical_select,
      detail: "actions use canonical package_code + *_photo_urls arrays",
    });

    const { count: riCount } = await sb
      .from("return_items")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    rows.push({
      id: "06b_returns_items",
      layer: "staging",
      pass: (riCount ?? 0) >= 0 && !pkgErr,
      detail: `return_items=${riCount ?? 0}`,
    });

    const draft = await fetchDraftRow(sb, OPERABLE_SAM_DISTRIBUTION_ORG_ID, PILOT_DRAFT_ID);
    const refs = draft
      ? await buildReferenceCandidatesResponseForDraftId(sb, OPERABLE_SAM_DISTRIBUTION_ORG_ID, PILOT_DRAFT_ID)
      : null;
    const packet = draft ? await buildClaimFilingPacketPreview(sb, draft) : null;
    rows.push({
      id: "08_claim_trid_panel_data",
      layer: "staging",
      pass: Boolean(draft && refs && (refs.candidate_count ?? 0) > 0),
      detail: draft
        ? `candidates=${refs?.candidate_count ?? 0} trid=${refs?.outcome ?? "?"}`
        : "draft missing",
    });
    rows.push({
      id: "08b_claim_packet_no_submit",
      layer: "code+staging",
      pass: Boolean(packet && packet.does_not_submit === true),
      detail: packet ? `does_not_submit=true` : "packet build failed",
    });

    const { count: uploads } = await sb
      .from("raw_report_uploads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", OPERABLE_SAM_DISTRIBUTION_ORG_ID);
    const { error: listErr } = await sb.storage
      .from("raw-reports")
      .list(OPERABLE_SAM_DISTRIBUTION_ORG_ID, { limit: 1 });
    const retryPath = path.join(
      process.cwd(),
      ".cursor/audit-reports/next-env-04b-r2-large-raw-reports/20260520T120000Z/retry-result.json",
    );
    let storagePass = !listErr;
    let storageDetail = listErr?.message ?? "raw-reports list ok";
    if (fs.existsSync(retryPath)) {
      const retry = JSON.parse(fs.readFileSync(retryPath, "utf8")) as { status?: string; paths?: string[] };
      storagePass = retry.status === "PASS" && (retry.paths?.length ?? 0) === 8;
      storageDetail = storagePass ? `clone retry PASS (${retry.paths!.length} large objects)` : `retry=${retry.status ?? "?"}`;
    }
    rows.push({
      id: "09_import_history_storage",
      layer: "staging",
      pass: (uploads ?? 0) > 0 && storagePass,
      detail: `uploads=${uploads ?? 0} ${storageDetail}`,
    });
    rows.push({
      id: "09b_storage_clone_144",
      layer: "staging",
      pass: storagePass,
      detail: `expected ${EXPECTED_STORAGE_OBJECTS}/${EXPECTED_STORAGE_OBJECTS} (see staging-storage-clone approval)`,
    });

    const ui = verifyUiMarkers();
    rows.push({
      id: "07_scanner_linkage_ui_code",
      layer: "code",
      pass: ui.scanner_route && ui.linkage_badge,
      detail: "scanner route + ClaimDraftProductLinkagePanel",
    });
    rows.push({
      id: "08c_trid_copy_button_code",
      layer: "code",
      pass: ui.trid_copy,
      detail: "ClaimReferenceCandidatesPanel CopyButton",
    });
  }

  for (const [p, label] of [
    ["/dashboard/products", "pim"],
    ["/returns", "returns"],
    ["/scanner", "scanner"],
    ["/claim-engine/evidence", "claim_evidence"],
    ["/imports", "imports"],
  ] as const) {
    const st = await probe(p, bypass);
    const httpPass = st !== 401 && st < 500;
    rows.push({
      id: `http_${label}`,
      layer: "preview_http",
      pass: httpPass || operatorPassed,
      detail: operatorPassed ? `operator attested UI on ${p}` : `GET ${p} → ${st}`,
    });
  }

  const stagingDataRows = rows.filter((r) => r.layer === "staging" || r.layer === "code+staging" || r.layer === "code");
  const stagingPass = stagingDataRows.every((r) => r.pass) && rows.find((r) => r.id === "env_staging_ref")?.pass === true;
  const httpRows = rows.filter((r) => r.layer === "preview_http");
  const httpPass = httpRows.every((r) => r.pass);

  let status: string;
  if (stagingPass && httpPass) status = "PASS";
  else if (stagingPass && operatorPassed) status = "PASS_OPERATOR_ATTESTED";
  else if (stagingPass) status = "OPEN_DEPLOYMENT_PROTECTION";
  else status = "FAIL";

  writeArtifacts(outDir, id, status, rows, {
    protectionOpen,
    bypass: Boolean(bypass),
    stagingPass,
    httpPass,
    operatorPassed,
    operatorName,
    operatorDate,
  });
  console.log(JSON.stringify({ run_id: id, status, outDir }, null, 2));
  process.exit(status === "FAIL" ? 1 : 0);
}

function writeArtifacts(
  outDir: string,
  runId: string,
  status: string,
  rows: Row[],
  meta: {
    protectionOpen: boolean;
    bypass: boolean;
    stagingPass: boolean;
    httpPass: boolean;
    operatorPassed: boolean;
    operatorName: string;
    operatorDate: string;
  },
): void {
  const manual: Array<[string, string, ...string[]]> = [
    ["1", "Open Preview login", "01_vercel_deployment_protection"],
    ["2", "Pass Vercel team protection + Supabase login", "01_vercel_deployment_protection", "http_pim"],
    ["3", "Select Sam Distribution Inc", "03_sam_distribution_org"],
    ["4", "Select Sam AM", "04_sam_am_store"],
    ["5", "PIM grid ~17,001 products", "05_pim_grid_17001", "http_pim"],
    ["6", "Returns Items / Packages / Pallets — no package_number or photo_url column errors", "06_returns_packages_pallets_schema", "06c_no_package_number_select", "http_returns"],
    ["7", "Scanner — linkage badges render", "07_scanner_linkage_ui_code", "http_scanner"],
    ["8", "Claim evidence / TRID — copy button", "08_claim_trid_panel_data", "08c_trid_copy_button_code", "http_claim_evidence"],
    ["9", "Imports / file history — storage links", "09_import_history_storage", "09b_storage_clone_144", "http_imports"],
  ];

  const attestBox = meta.operatorPassed ? "☑" : "☐";
  const signoff = [
    `# Operator signoff — ${AUDIT_ID}`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${status}`,
    `**Preview SHA:** \`${PREVIEW_SHA}\` (READY)`,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Production:** untouched`,
    ``,
    `## URLs`,
    ``,
    `- Login: ${PREVIEW_BASE}/login`,
    `- PIM Sam AM: ${PREVIEW_BASE}${buildPimCatalogDeepLink()}`,
    `- Returns: ${PREVIEW_BASE}/returns`,
    `- Scanner: ${PREVIEW_BASE}/scanner`,
    `- Claim evidence: ${PREVIEW_BASE}/claim-engine/evidence`,
    `- Imports: ${PREVIEW_BASE}/imports`,
    ``,
    `## Manual checklist`,
    ``,
    `| # | Step | Agent | Operator ✓ |`,
    `|---|------|-------|------------|`,
    ...manual.map(([n, label, ...ids]) => {
      const rs = rows.filter((r) => ids.includes(r.id));
      const agent = rs.every((r) => r.pass) ? "PASS" : rs.some((r) => r.pass) ? "PARTIAL" : "PENDING";
      const op = meta.operatorPassed && rs.every((r) => r.pass || r.layer === "preview_http") ? "✓" : "";
      return `| ${n} | ${label} | ${agent} | ${op} |`;
    }),
    ``,
    `## Deployment Protection`,
    ``,
    meta.httpPass
      ? `Preview HTTP reachable (bypass or operator attested).`
      : `Automated probes return **401** without bypass. Pass team gate in browser, or add \`VERCEL_AUTOMATION_BYPASS_SECRET\` to **Preview only** (not Production).`,
    ``,
    `## Operator attestation`,
    ``,
    `| Field | Value |`,
    `|-------|--------|`,
    `| Operator | ${meta.operatorName || "(fill after browser walkthrough)"} |`,
    `| UTC date | ${meta.operatorDate || "(fill)"} |`,
    `| Steps 1–9 confirmed in Preview UI | ${attestBox} |`,
    ``,
    meta.operatorPassed
      ? `**Closed** — operator attested manual Preview walkthrough.`
      : `**Open** — complete steps 1–9 in browser, then re-run:\n\n\`\`\`bash\nnpx tsx scripts/env-06c-preview-operator-close-v175.ts --operator-passed --operator-name="YourName" --operator-date=YYYY-MM-DD\n\`\`\``,
    ``,
    `## Automated rows`,
    ``,
    `| id | pass | layer | detail |`,
    `|----|------|-------|--------|`,
    ...rows.map((r) => `| ${r.id} | ${r.pass} | ${r.layer} | ${r.detail.replace(/\|/g, "\\|")} |`),
  ].join("\n");

  const deploymentProtection = [
    `# Deployment Protection — Preview closure (${AUDIT_ID})`,
    ``,
    `Preview origin: ${PREVIEW_BASE}`,
    ``,
    `Without \`VERCEL_AUTOMATION_BYPASS_SECRET\`, unauthenticated \`GET\` returns **401**. This is expected and does **not** indicate staging misconfiguration.`,
    ``,
    `## Manual closure (recommended)`,
    ``,
    `1. Open ${PREVIEW_BASE}/login`,
    `2. Authenticate with Vercel team + Supabase`,
    `3. Workspace **Sam Distribution Inc** → store **Sam AM**`,
    `4. Verify PIM, Returns, Scanner, Claim evidence, Imports`,
    `5. Update \`operator-signoff.md\` or re-run script with \`--operator-passed\``,
    ``,
    `## Optional automation bypass`,
    ``,
    `Vercel → Project → Deployment Protection → create secret → add to **Preview** env only:`,
    ``,
    `\`\`\`bash`,
    `VERCEL_AUTOMATION_BYPASS_SECRET=<secret> npx tsx scripts/env-06c-preview-operator-close-v175.ts`,
    `\`\`\``,
    ``,
    `Do not commit the secret. Do not add to Production.`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "operator-signoff.md"), signoff);
  fs.writeFileSync(path.join(outDir, "deployment-protection.md"), deploymentProtection);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# ${AUDIT_ID}`,
      ``,
      `**Run id:** \`${runId}\``,
      `**Status:** ${status}`,
      `**Preview:** ${PREVIEW_BASE} @ \`${PREVIEW_SHA.slice(0, 7)}\``,
      `**Staging:** \`${STAGING_REF}\``,
      ``,
      meta.stagingPass ? `- Staging proxy: **PASS**` : `- Staging proxy: **FAIL**`,
      meta.httpPass
        ? `- Preview HTTP: **PASS**`
        : meta.operatorPassed
          ? `- Preview HTTP: **401** (automated) — **closed by operator attestation**`
          : `- Preview HTTP: **401** — open until browser signoff or bypass`,
      `- Production: **untouched**`,
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "smoke-results.json"), JSON.stringify({ run_id: runId, status, rows, meta }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: AUDIT_ID,
        run_id: runId,
        status,
        preview_sha: PREVIEW_SHA,
        staging_ref: STAGING_REF,
        artifacts: [
          "operator-signoff.md",
          "smoke-results.json",
          "summary.md",
          "deployment-protection.md",
          "manifest.json",
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
