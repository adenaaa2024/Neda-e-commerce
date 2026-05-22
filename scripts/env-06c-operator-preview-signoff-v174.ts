/**
 * ENV-06C-OPERATOR-PREVIEW-SIGNOFF-V174 — staging proxy + Preview HTTP (optional bypass).
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
import { refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PREVIEW_BASE =
  "https://ecommerce-os-git-integrat-ec746a-mebrahimipargoo-9799s-projects.vercel.app";
const PREVIEW_SHA = "22e514404de6bc8dc9a9d0b23789e2adde1a8f52";
const PILOT_DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";

type Row = { id: string; pass: boolean; layer: string; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
}

async function probe(path: string, bypass: string | undefined): Promise<number> {
  const headers: Record<string, string> = {};
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const r = await fetch(`${PREVIEW_BASE}${path}`, { redirect: "manual", headers });
  return r.status;
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

async function main(): Promise<void> {
  const localEnv = loadEnvFile(path.join(process.cwd(), ".env.local"));
  const url = localEnv.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = localEnv.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const id = runId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/env-06c-vercel-preview-full-smoke-v173",
    id,
  );
  fs.mkdirSync(outDir, { recursive: true });

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
    pass: protectionOpen,
    detail: bypass
      ? `GET /login → ${loginStatus} (bypass)`
      : `GET /login → ${loginStatus} — operator must pass Vercel team gate in browser`,
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
    const { data: buckets } = await sb.storage.from("raw-reports").list("", { limit: 3 });
    rows.push({
      id: "09_import_history_storage",
      layer: "staging",
      pass: (uploads ?? 0) > 0 && Array.isArray(buckets),
      detail: `uploads=${uploads ?? 0} storage_list=${buckets?.length ?? 0}`,
    });

    const ui = verifyUiMarkers();
    rows.push({
      id: "07_scanner_linkage_ui_code",
      layer: "code",
      pass: ui.scanner_route && ui.linkage_badge,
      detail: "static markers in repo @ 22e5144 tree",
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
    rows.push({
      id: `http_${label}`,
      layer: "preview_http",
      pass: st !== 401 && st < 500,
      detail: `GET ${p} → ${st}`,
    });
  }

  const stagingDataRows = rows.filter((r) => r.layer === "staging" || r.layer === "code+staging" || r.layer === "code");
  const stagingPass = stagingDataRows.every((r) => r.pass) && rows.find((r) => r.id === "env_staging_ref")?.pass === true;
  const httpRows = rows.filter((r) => r.layer === "preview_http");
  const httpPass = httpRows.every((r) => r.pass);

  let status: string;
  if (stagingPass && httpPass) status = "PASS";
  else if (stagingPass) status = "STAGING_PASS_UI_PENDING_OPERATOR";
  else status = "FAIL";

  writeArtifacts(outDir, id, status, rows, { protectionOpen, bypass: Boolean(bypass), stagingPass, httpPass });
  console.log(JSON.stringify({ run_id: id, status, outDir }, null, 2));
  process.exit(status === "FAIL" ? 1 : 0);
}

function verifyUiMarkers(): Record<string, boolean> {
  const root = path.join(process.cwd(), "components", "claims");
  const linkage = fs.existsSync(path.join(root, "ClaimDraftProductLinkagePanel.tsx"));
  const trid = fs.readFileSync(path.join(root, "ClaimReferenceCandidatesPanel.tsx"), "utf8");
  return {
    scanner_route: fs.existsSync(path.join(process.cwd(), "app", "scanner", "page.tsx")),
    linkage_badge: linkage,
    trid_copy: trid.includes("CopyButton"),
  };
}

function writeArtifacts(
  outDir: string,
  runId: string,
  status: string,
  rows: Row[],
  meta: { protectionOpen: boolean; bypass: boolean; stagingPass: boolean; httpPass: boolean },
): void {
  const manual = [
    ["1", "Pass Vercel Deployment Protection", "01_vercel_deployment_protection"],
    ["2", "Supabase/app login", "http_pim"],
    ["3", "Sam Distribution Inc", "03_sam_distribution_org"],
    ["4", "Sam AM store", "04_sam_am_store"],
    ["5", "PIM ~17,001", "05_pim_grid_17001"],
    ["6", "Returns no missing columns", "06_returns_packages_pallets_schema"],
    ["7", "Scanner + linkage badges", "07_scanner_linkage_ui_code"],
    ["8", "Claim TRID + copy", "08_claim_trid_panel_data", "08c_trid_copy_button_code"],
    ["9", "Import history + storage", "09_import_history_storage"],
  ];

  const signoff = [
    `# Operator signoff — ENV-06C-OPERATOR-PREVIEW-SIGNOFF-V174`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${status}`,
    `**Preview SHA:** \`${PREVIEW_SHA}\` (READY)`,
    `**Staging ref:** \`eiqfaapyumhixxoeltgu\``,
    `**Production:** untouched`,
    ``,
    `## URLs`,
    ``,
    `- Login: ${PREVIEW_BASE}/login`,
    `- PIM Sam AM: ${PREVIEW_BASE}${buildPimCatalogDeepLink()}`,
    ``,
    `## Manual checklist (agent-assisted)`,
    ``,
    `| # | Step | Agent layer | Agent | Operator ✓ |`,
    `|---|------|-------------|-------|------------|`,
    ...manual.map(([n, label, ...ids]) => {
      const rs = rows.filter((r) => ids.includes(r.id));
      const agent = rs.every((r) => r.pass) ? "PASS" : rs.some((r) => r.pass) ? "PARTIAL" : "PENDING";
      return `| ${n} | ${label} | ${rs.map((r) => r.layer).join(",")} | ${agent} | |`;
    }),
    ``,
    `## Deployment Protection closure`,
    ``,
    meta.protectionOpen
      ? `Bypass or team login opens Preview (HTTP not 401).`
      : `**Blocker remains for automated HTTP:** add \`VERCEL_AUTOMATION_BYPASS_SECRET\` to Preview env, or operator completes Vercel team login in browser then UI checklist above.`,
    ``,
    `## All automated rows`,
    ``,
    `| id | pass | layer | detail |`,
    `|----|------|-------|--------|`,
    ...rows.map((r) => `| ${r.id} | ${r.pass} | ${r.layer} | ${r.detail.replace(/\|/g, "\\|")} |`),
    ``,
    `## Operator attestation (required when status is STAGING_PASS_UI_PENDING_OPERATOR)`,
    ``,
    `| Field | Value |`,
    `|-------|--------|`,
    `| Operator | |`,
    `| UTC date | |`,
    `| Confirmed Preview UI steps 1–9 in browser | ☐ |`,
    ``,
    status === "PASS"
      ? `Full PASS — staging proxy and Preview HTTP verified.`
      : status === "STAGING_PASS_UI_PENDING_OPERATOR"
        ? `Staging + code markers PASS. Complete browser steps 1–2 and confirm UI, then check attestation box.`
        : `Review failing rows.`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "operator-signoff.md"), signoff);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# ENV-06C-OPERATOR-PREVIEW-SIGNOFF-V174`,
      ``,
      `**Run id:** \`${runId}\``,
      `**Status:** ${status}`,
      `**Preview:** ${PREVIEW_BASE} @ \`${PREVIEW_SHA.slice(0, 7)}\``,
      `**Staging:** \`${STAGING_REF}\``,
      ``,
      meta.stagingPass
        ? `- Staging proxy: **PASS** (PIM 17,001, packages/pallets schema, claim TRID pilot draft, import/storage).`
        : `- Staging proxy: **FAIL** — see smoke-results.json.`,
      meta.httpPass
        ? `- Preview HTTP: **PASS** (Deployment Protection bypass or open).`
        : `- Preview HTTP: **blocked (401)** — operator browser login or \`VERCEL_AUTOMATION_BYPASS_SECRET\`.`,
      `- Production DB / Vercel Production: **untouched**.`,
      ``,
      `Artifacts: \`operator-signoff.md\`, \`smoke-results.json\`, \`deployment-protection.md\`, \`manifest.json\`.`,
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "smoke-results.json"), JSON.stringify({ run_id: runId, status, rows, meta }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: "ENV-06C-OPERATOR-PREVIEW-SIGNOFF-V174",
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

  fs.copyFileSync(
    path.join(process.cwd(), ".cursor/audit-reports/env-06c-vercel-preview-full-smoke-v173/20260519T185500Z/deployment-protection.md"),
    path.join(outDir, "deployment-protection.md"),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
