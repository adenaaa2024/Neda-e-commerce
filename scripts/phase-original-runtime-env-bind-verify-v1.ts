/**
 * PHASE-ORIGINAL-RUNTIME-ENV-BIND-VERIFY-V1
 * Emergency runtime verification — read-only, no DB writes.
 *
 *   npx tsx scripts/phase-original-runtime-env-bind-verify-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildNedaInventoryItemStatusRow,
  classifyViewLinkage,
} from "../lib/inventory-views-product-linkage";
import {
  PRODUCT_LINKAGE_LABEL_NO_LINK,
  productLinkageUserStatusLabel,
} from "../lib/product-linkage-display-ui";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-original-runtime-env-bind-verify-v1";

const SAMPLES = ["X004LKS4VD", "X003VSWH37", "ZQCPD4GHB", "ZZQCP25AW3"];

const FIX_FILES = [
  "lib/product-linkage-display-contract.ts",
  "lib/product-linkage-display-enrich.ts",
  "lib/product-linkage-display-ui.ts",
  "lib/inventory-views-product-linkage.ts",
];

const FIX_MARKERS: Record<string, string[]> = {
  "lib/product-linkage-display-contract.ts": ["effectiveResolvedProductId", "displayLinkageStatus"],
  "lib/product-linkage-display-enrich.ts": ["mapRowToProductLinkageDisplayContract", "product_identifier_map"],
  "lib/product-linkage-display-ui.ts": ["PRODUCT_LINKAGE_LABEL_NO_LINK", "linkage.is_resolved"],
  "lib/inventory-views-product-linkage.ts": ["resolveInventoryViewProductLinkage", "buildNedaInventoryItemStatusRow"],
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function jwtRef(key: string | undefined): string | null {
  if (!key?.includes(".")) return null;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString("utf8")) as {
      ref?: string;
    };
    return payload.ref?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function sbClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false } });
}

function keysMatch(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a?.trim() && b?.trim() && a.trim() === b.trim());
}

function urlsMatch(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a?.trim() && b?.trim() && a.trim() === b.trim());
}

function checkFixFiles(): Record<string, { exists: boolean; markers_ok: boolean; missing_markers: string[] }> {
  const out: Record<string, { exists: boolean; markers_ok: boolean; missing_markers: string[] }> = {};
  for (const rel of FIX_FILES) {
    const abs = path.join(process.cwd(), rel);
    const exists = fs.existsSync(abs);
    const markers = FIX_MARKERS[rel] ?? [];
    const text = exists ? fs.readFileSync(abs, "utf8") : "";
    const missing = markers.filter((m) => !text.includes(m));
    out[rel] = { exists, markers_ok: exists && missing.length === 0, missing_markers: missing };
  }
  return out;
}

function detectDevServers(): { running: boolean; notes: string[] } {
  const notes: string[] = [];
  let running = false;
  const termDir = path.join(process.env.USERPROFILE ?? "", ".cursor", "projects");
  try {
    const proj = path.join(termDir, "c-Users-Jennifer-Desktop-ecommerce-os", "terminals");
    if (fs.existsSync(proj)) {
      for (const f of fs.readdirSync(proj)) {
        if (!f.endsWith(".txt")) continue;
        const t = fs.readFileSync(path.join(proj, f), "utf8");
        if (/active_command:.*npm run dev|> next dev/m.test(t)) {
          running = true;
          notes.push(`dev server active in terminal ${f}`);
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const out = execSync('netstat -ano | findstr ":3000 :3001"', { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    if (out.includes("LISTENING")) notes.push("ports 3000/3001 listening");
  } catch {
    /* ignore */
  }
  return { running, notes };
}

async function mapHit(
  sb: SupabaseClient,
  identifier: string,
): Promise<{ hit: boolean; product_id: string | null; product_name: string | null }> {
  const upper = identifier.trim().toUpperCase();
  const { data } = await sb
    .from("product_identifier_map")
    .select("product_id, products(product_name, name)")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .is("deleted_at", null)
    .or(
      `asin.eq.${upper},fnsku.eq.${upper},seller_sku.eq.${upper},msku.eq.${upper}`,
    )
    .limit(1);
  const row = data?.[0] as Record<string, unknown> | undefined;
  const prod = row?.products as { product_name?: string; name?: string } | null;
  const name = prod?.product_name ?? prod?.name ?? null;
  return {
    hit: Boolean(row?.product_id),
    product_id: (row?.product_id as string | null) ?? null,
    product_name: name,
  };
}

async function shipmentEntryLinkageSmoke(
  sb: SupabaseClient,
  bindLabel: string,
  identifier: string,
): Promise<Record<string, unknown>> {
  const upper = identifier.trim().toUpperCase();

  const map = await mapHit(sb, identifier);

  const { data: viewRows, error: viewErr } = await sb
    .from("v_inventory_item_status")
    .select("*")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .or(`fnsku.eq.${upper},sku.eq.${upper},asin.eq.${upper},package_code.eq.${upper},slip_code.eq.${upper}`)
    .limit(3);

  const viewRow = (viewRows?.[0] ?? null) as Record<string, unknown> | null;
  let nedaRow: Awaited<ReturnType<typeof buildNedaInventoryItemStatusRow>> | null = null;
  if (viewRow) {
    const columns = Object.keys(viewRow);
    const linkageClass = classifyViewLinkage("v_inventory_item_status", columns);
    nedaRow = await buildNedaInventoryItemStatusRow(sb, viewRow, linkageClass);
  }

  const linkage = nedaRow?.product_linkage;
  const displayLabel = linkage ? productLinkageUserStatusLabel(linkage) : null;

  return {
    bind: bindLabel,
    identifier,
    view_rows_found: viewRows?.length ?? 0,
    view_error: viewErr?.message ?? null,
    product_id: linkage?.product_id ?? map.product_id ?? viewRow?.product_id ?? null,
    product_name: linkage?.product_name ?? map.product_name ?? viewRow?.product_name ?? null,
    product_identifier_map_hit: map.hit,
    product_linkage_status: viewRow?.product_linkage_status ?? null,
    identifier_resolution_status:
      linkage?.identifier_resolution_status ?? viewRow?.identifier_resolution_status ?? null,
    resolved_product_id: linkage?.resolved_product_id ?? viewRow?.resolved_product_id ?? null,
    is_resolved: linkage?.is_resolved ?? null,
    display_label_expected_by_ui: displayLabel,
    shows_no_link: displayLabel === PRODUCT_LINKAGE_LABEL_NO_LINK,
    linkage_source: nedaRow?.linkage_source ?? null,
    endpoint_path:
      "server action fetchInventoryItemStatusForNeda → v_inventory_item_status → buildNedaInventoryItemStatusRow → ProductLinkageDisplayBlock",
  };
}

async function main() {
  loadEnvLocalIntoProcess();

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const nextPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const runtimeRef = refFromSupabaseUrl(nextPublicUrl);
  const originalRef = refFromSupabaseUrl(originalUrl) ?? ORIGINAL_REF;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const originalServiceKey = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  const serviceKeyRef = jwtRef(serviceKey);
  const originalServiceKeyRef = jwtRef(originalServiceKey);

  const urlMatchesOriginal = urlsMatch(nextPublicUrl, originalUrl);
  const serviceKeyMatchesOriginal = keysMatch(serviceKey, originalServiceKey);
  const serviceKeyRefMatchesOriginal =
    Boolean(serviceKeyRef && originalServiceKeyRef && serviceKeyRef === originalServiceKeyRef);

  const expectedOriginalRefMatch =
    runtimeRef === ORIGINAL_REF && urlMatchesOriginal && serviceKeyMatchesOriginal;

  let envBindStatus: string;
  if (expectedOriginalRefMatch) {
    envBindStatus = "BOUND_TO_ORIGINAL";
  } else if (runtimeRef === STAGING_REF) {
    envBindStatus = "MISMATCH_RUNTIME_POINTS_AT_STAGING";
  } else {
    envBindStatus = "MISMATCH_UNKNOWN_REF";
  }

  const devServers = detectDevServers();
  const devServerRestartNeeded = !expectedOriginalRefMatch || devServers.running;

  let gitCommit = "unknown";
  let gitBranch = "unknown";
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    gitBranch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const fixFiles = checkFixFiles();
  const allFixFilesOk = Object.values(fixFiles).every((f) => f.exists && f.markers_ok);

  const runtimeSb = sbClient(nextPublicUrl, serviceKey);
  const originalSb =
    originalUrl && originalServiceKey
      ? sbClient(originalUrl, originalServiceKey)
      : runtimeSb;

  const sampleRuntimePayloads: Record<string, unknown>[] = [];
  for (const id of SAMPLES) {
    const runtime = await shipmentEntryLinkageSmoke(runtimeSb, "runtime_env", id);
    const originalBound = await shipmentEntryLinkageSmoke(originalSb, "original_bound", id);
    sampleRuntimePayloads.push({ identifier: id, runtime_env: runtime, original_bound: originalBound });
  }

  const runtimeStillNoLink = sampleRuntimePayloads.filter((s) => {
    const r = s.runtime_env as { shows_no_link?: boolean };
    return r.shows_no_link === true;
  });

  let noLinkReasonIfStillPresent: string | null = null;
  if (runtimeStillNoLink.length > 0) {
    if (!expectedOriginalRefMatch) {
      noLinkReasonIfStillPresent =
        "runtime_env_mismatch: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY still point at staging (or wrong ref); dev server must be restarted after swapping to ORIGINAL_*";
    } else if (!allFixFilesOk) {
      noLinkReasonIfStillPresent = "minimal_mapper_fix_files_missing_or_incomplete_in_worktree";
    } else {
      noLinkReasonIfStillPresent =
        "operational_row_or_view_missing_linkage_fields_despite_original_bind; check store_id on view rows";
    }
  } else if (!expectedOriginalRefMatch) {
    noLinkReasonIfStillPresent =
      "runtime still on staging ref — UI may differ from original DB expectations until env bind + restart";
  }

  const result = {
    phase: "PHASE-ORIGINAL-RUNTIME-ENV-BIND-VERIFY-V1",
    run_id: rid,
    runtime_project_ref: runtimeRef,
    expected_original_ref: ORIGINAL_REF,
    expected_original_ref_match: expectedOriginalRefMatch ? "yes" : "no",
    env_bind_status: envBindStatus,
    env_details: {
      NEXT_PUBLIC_SUPABASE_URL_ref: runtimeRef,
      ORIGINAL_SUPABASE_URL_ref: originalRef,
      url_matches_original: urlMatchesOriginal,
      service_role_key_matches_original: serviceKeyMatchesOriginal,
      service_role_jwt_ref: serviceKeyRef,
      original_service_role_jwt_ref: originalServiceKeyRef,
      service_role_jwt_ref_matches: serviceKeyRefMatchesOriginal,
      NEXT_PUBLIC_STORE_ID: process.env.NEXT_PUBLIC_STORE_ID ?? null,
    },
    dev_server_restart_needed: devServerRestartNeeded ? "yes" : "no",
    dev_server_notes: devServers.notes,
    loaded_commit_and_files: {
      git_commit: gitCommit,
      git_branch: gitBranch,
      fix_files: fixFiles,
      all_fix_files_present_and_marked: allFixFilesOk,
    },
    sample_runtime_payloads: sampleRuntimePayloads,
    no_link_reason_if_still_present: noLinkReasonIfStillPresent,
    NO_DATA_MUTATION_VERIFICATION: true,
    SAFE_TO_CONTINUE_TO_UI_SMOKE: expectedOriginalRefMatch && allFixFilesOk ? "yes" : "no",
    NEXT_PROMPT: expectedOriginalRefMatch
      ? "PHASE-ORIGINAL-SHIPMENT-ENTRY-LINKAGE-UI-SMOKE-V1"
      : "PHASE-ORIGINAL-RUNTIME-ENV-SWAP-AND-RESTART-V1",
  };

  fs.writeFileSync(path.join(outDir, "verify-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "verify-summary.md"),
    `# Runtime env bind verify

**Run:** ${rid}
**Runtime ref:** ${runtimeRef} (expected ${ORIGINAL_REF}) → **match: ${result.expected_original_ref_match}**
**Env bind:** ${envBindStatus}
**Dev restart needed:** ${result.dev_server_restart_needed}
**Fix files OK:** ${allFixFilesOk}
**SAFE_TO_CONTINUE_TO_UI_SMOKE:** ${result.SAFE_TO_CONTINUE_TO_UI_SMOKE}

## Samples (runtime env)
${sampleRuntimePayloads
  .map((s) => {
    const r = s.runtime_env as Record<string, unknown>;
    return `- **${s.identifier}**: map=${r.product_identifier_map_hit} resolved=${r.resolved_product_id ?? "—"} label=${r.display_label_expected_by_ui ?? "—"}`;
  })
  .join("\n")}
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        outDir,
        runtime_project_ref: runtimeRef,
        expected_original_ref_match: result.expected_original_ref_match,
        env_bind_status: envBindStatus,
        dev_server_restart_needed: result.dev_server_restart_needed,
        SAFE_TO_CONTINUE_TO_UI_SMOKE: result.SAFE_TO_CONTINUE_TO_UI_SMOKE,
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
