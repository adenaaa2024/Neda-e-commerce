/**
 * SCHEMA-RECONCILE-FINAL-PROOF-V176 — read-only closure proof after V173/V174/V175.
 * Usage: npx tsx scripts/schema-reconcile-final-proof-v176.ts --run-id=<id> [--skip-build]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import {
  PACKAGE_LIST_SELECT,
  PALLET_LIST_SELECT,
} from "../lib/package-pallet-canonical";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_PRODUCTS = 17_001;

const SCAN_ROOTS = ["app", "lib"] as const;
const SCAN_EXT = new Set([".ts", ".tsx"]);

const STALE_PATTERNS: { id: string; re: RegExp; allowPaths?: RegExp[] }[] = [
  { id: "from_returns_table", re: /\.from\(\s*["']returns["']\s*\)/ },
  { id: "from_package_items", re: /\.from\(\s*["']package_items["']\s*\)/ },
  { id: "select_package_number", re: /\.select\([^)]*package_number/ },
  {
    id: "pallets_photo_url_column",
    re: /\.from\(\s*["']pallets["']\s*\)[\s\S]{0,120}\.select\([^)]*["']photo_url["']/,
  },
  { id: "expected_item_id", re: /\bexpected_item_id\b/ },
  {
    id: "packages_package_number_prop",
    re: /packages\.package_number|["']package_number["']\s*:/,
    allowPaths: [/package-pallet-canonical\.ts$/],
  },
];

type Row = { id: string; pass: boolean; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".next") continue;
      walkTsFiles(full, out);
    } else if (SCAN_EXT.has(path.extname(ent.name))) {
      out.push(full);
    }
  }
}

function scanStaleRefs(): { hits: { pattern: string; file: string; line: number; excerpt: string }[] } {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walkTsFiles(path.join(process.cwd(), root), files);
  const hits: { pattern: string; file: string; line: number; excerpt: string }[] = [];

  for (const file of files) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const pat of STALE_PATTERNS) {
      if (pat.allowPaths?.some((a) => a.test(rel))) continue;
      lines.forEach((line, i) => {
        if (pat.re.test(line)) {
          hits.push({
            pattern: pat.id,
            file: rel,
            line: i + 1,
            excerpt: line.trim().slice(0, 160),
          });
        }
      });
    }
  }
  return { hits };
}

function verifyReturnsActionsMarkers(): Row {
  const actionsPath = path.join(process.cwd(), "app/returns/actions.ts");
  const text = fs.readFileSync(actionsPath, "utf8");
  const bad =
    /\.select\([^)]*package_number/.test(text) ||
    /\.select\([^)]*["']photo_url["']/.test(text) ||
    text.includes('.from("returns")');
  const good =
    text.includes("PACKAGE_LIST_SELECT") &&
    text.includes("PALLET_LIST_SELECT") &&
    text.includes("RETURN_ITEMS_TABLE");
  return {
    id: "returns_actions_canonical",
    pass: !bad && good,
    detail: bad
      ? "legacy select or returns table ref in actions.ts"
      : "PACKAGE_/PALLET_ selects + RETURN_ITEMS_TABLE",
  };
}

function runBuild(): Row {
  if (process.argv.includes("--skip-build")) {
    return { id: "npm_build", pass: true, detail: "skipped (--skip-build)" };
  }
  const r = spawnSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    shell: true,
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
  });
  const ok = r.status === 0;
  return {
    id: "npm_build",
    pass: ok,
    detail: ok ? "npm run build exit 0" : `exit ${r.status}: ${(r.stderr || r.stdout || "").slice(-800)}`,
  };
}

async function main(): Promise<void> {
  const id = runId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/schema-reconcile-final-proof-v176",
    id,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const matrix: Row[] = [];
  loadEnvLocalIntoProcess();

  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  matrix.push({
    id: "env_staging_ref",
    pass: ref === STAGING_REF && getStagingProjectRef({ loadEnv: false }) === STAGING_REF,
    detail: `active ref=${ref ?? "?"}`,
  });

  const { hits } = scanStaleRefs();
  matrix.push({
    id: "app_lib_stale_refs",
    pass: hits.length === 0,
    detail:
      hits.length === 0
        ? "no stale patterns in app/ + lib/"
        : `${hits.length} hit(s): ${hits.map((h) => `${h.pattern}@${h.file}:${h.line}`).join("; ")}`,
  });

  matrix.push(verifyReturnsActionsMarkers());

  const pkgSelectOk =
    PACKAGE_LIST_SELECT.includes("package_code") &&
    !/\bpackage_number\b/.test(PACKAGE_LIST_SELECT);
  const pltSelectOk =
    PALLET_LIST_SELECT.includes("pallet_photo_urls") &&
    !/\bphoto_url\b/.test(PALLET_LIST_SELECT);
  matrix.push({
    id: "canonical_select_constants",
    pass: pkgSelectOk && pltSelectOk && RETURN_ITEMS_TABLE === "return_items",
    detail: `packages→package_code; pallets→pallet_photo_urls; table=${RETURN_ITEMS_TABLE}`,
  });

  const routes = [
    ["returns_page", "app/returns/page.tsx"],
    ["scanner_page", "app/scanner/page.tsx"],
    ["products_page", "app/dashboard/products/page.tsx"],
    ["package_pallet_canonical", "lib/package-pallet-canonical.ts"],
  ] as const;
  for (const [rid, rel] of routes) {
    matrix.push({
      id: `surface_${rid}`,
      pass: fs.existsSync(path.join(process.cwd(), rel)),
      detail: rel,
    });
  }

  matrix.push(runBuild());

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (url && key && ref === STAGING_REF) {
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const { error: pkgErr } = await sb.from("packages").select("id, package_code, inside_photo_urls").limit(1);
    const { error: pkgLegacyErr } = await sb.from("packages").select("package_number").limit(1);
    matrix.push({
      id: "db_packages_canonical",
      pass: !pkgErr && !!pkgLegacyErr,
      detail: pkgErr
        ? `package_code select failed: ${pkgErr.message}`
        : pkgLegacyErr
          ? "package_number absent (expected error)"
          : "unexpected: package_number may still exist",
    });

    const { error: pltErr } = await sb.from("pallets").select("id, pallet_photo_urls, bol_photo_urls").limit(1);
    const { error: pltLegacyErr } = await sb.from("pallets").select("photo_url").limit(1);
    matrix.push({
      id: "db_pallets_canonical",
      pass: !pltErr && !!pltLegacyErr,
      detail: pltErr
        ? `pallet_photo_urls select failed: ${pltErr.message}`
        : pltLegacyErr
          ? "photo_url absent (expected error)"
          : "unexpected: photo_url may still exist",
    });

    const { error: retErr } = await sb.from("return_items").select("id").eq("organization_id", ORG).limit(1);
    const { error: legacyRet } = await sb.from("returns").select("id").limit(1);
    matrix.push({
      id: "db_return_items_not_returns",
      pass: !retErr && !!legacyRet,
      detail: retErr
        ? retErr.message
        : legacyRet
          ? "returns table absent or blocked (expected)"
          : "returns still queryable",
    });

    const { error: pkgItemsErr } = await sb.from("package_items").select("id").limit(1);
    matrix.push({
      id: "db_package_items_forbidden",
      pass: !!pkgItemsErr,
      detail: pkgItemsErr ? "package_items absent (expected)" : "package_items exists",
    });

    const { count } = await sb
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
      .eq("store_id", STORE)
      .is("deleted_at", null);
    matrix.push({
      id: "db_pim_product_count",
      pass: count === TARGET_PRODUCTS,
      detail: `products=${count ?? "?"} target=${TARGET_PRODUCTS}`,
    });
  } else {
    matrix.push({
      id: "db_staging_checks",
      pass: false,
      detail: "skipped — staging env not configured",
    });
  }

  const status = matrix.every((r) => r.pass) ? "PASS" : "FAIL";
  const payload = {
    run_id: id,
    prompt: "SCHEMA-RECONCILE-FINAL-PROOF-V176",
    status,
    matrix,
    stale_scan: { hits },
    canonical: {
      packages: {
        code: "package_code",
        photos: ["inside_photo_urls", "outside_photo_urls", "slip_photo_urls"],
        manifest: "manifest_photo_url",
        counts: ["expected_item_count", "actual_item_count"],
      },
      pallets: {
        photos: ["pallet_photo_urls", "bol_photo_urls", "shipping_label_urls"],
        manifest: "manifest_photo_url",
      },
      line_items_table: "return_items",
      forbidden: ["package_items", "returns (legacy table name in queries)"],
    },
    predecessors: [
      "SCHEMA-RECONCILE-NEDA-DB-RENAME-UI-FIX-V173",
      "product-id-mapping-materialization-v174",
      "schema-product-combined-smoke-v175",
      "env-06c-preview-operator-close-v175",
    ],
  };

  fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "stale-ref-hits.json"), JSON.stringify(hits, null, 2));
  console.log(JSON.stringify({ run_id: id, status, outDir, fail: matrix.filter((m) => !m.pass) }, null, 2));
  process.exit(status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
