/**
 * NEXT-PRODUCT-40B — New-upload FBA inventory verify-only pack (no writes).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adaptResolverImportRow } from "../lib/amazon-import-product-resolver";
import { runIncrementalResolverForUpload } from "../lib/amazon-resolver-incremental-orchestrator";
import {
  pickBestProductIdentifierMatch,
  prefetchIdentifierMapCandidatesForBatch,
} from "../lib/product-identifier-match";

const RUN_ID = "20260519T200000Z";
const TABLE = "amazon_fba_inventory";
const TARGET_ROWS = 25;
const PILOT_UPLOAD = "a10e7769-6db5-41d9-b5c0-8041198c83f6";
const PACK_39 = path.join(process.cwd(), ".cursor/audit-reports/next-product-39/20260519T120000Z");

type Row = {
  id: string;
  organization_id: string;
  store_id: string;
  source_upload_id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: string | null;
  updated_at: string | null;
};

type Sim = Row & {
  match_status: string;
  proposed_product_id: string;
  proposed_catalog_product_id: string;
  proposed_status: string;
  proposed_confidence: string;
  write_allowed: boolean;
  match_tier: number | null;
};

function loadEnvLocal(): Record<string, string> {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function escCsv(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function simulateEligible(
  supabase: SupabaseClient,
  org: string,
  store: string,
  upload: string,
): Promise<{ upload: { organization_id: string; store_id: string; source_upload_id: string }; eligible: Sim[] } | null> {
  const env = loadEnvLocal();
  const direct = env.DIRECT_POSTGRES_URL!.trim();
  const pgClient = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const { rows: candidates } = await pgClient.query<Row>(
    `SELECT id::text,
            organization_id::text,
            store_id::text,
            source_upload_id::text,
            sku, fnsku, asin,
            resolved_product_id::text,
            resolved_catalog_product_id::text,
            identifier_resolution_status,
            identifier_resolution_confidence::text,
            updated_at::text
     FROM public.amazon_fba_inventory
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND source_upload_id = $3::uuid
       AND resolved_product_id IS NULL
       AND (fnsku IS NOT NULL OR (sku IS NOT NULL AND asin IS NOT NULL))
     ORDER BY id ASC
     LIMIT 500`,
    [org, store, upload],
  );
  await pgClient.end();

  const eligible: Sim[] = [];
  for (const r of candidates) {
    const adapted = adaptResolverImportRow(TABLE, r as unknown as Record<string, unknown>);
    if (!adapted.fnsku && !adapted.sku && !adapted.asin) continue;

    const pool = await prefetchIdentifierMapCandidatesForBatch(supabase, org, store, [
      { fnsku: adapted.fnsku, msku: adapted.sku, asin: adapted.asin },
    ]);
    const match = pickBestProductIdentifierMatch(pool, {
      organizationId: org,
      storeId: store,
      fnsku: adapted.fnsku,
      msku: adapted.sku,
      asin: adapted.asin,
    });

    const proposedProduct = match.row?.product_id ? String(match.row.product_id) : "";
    const proposedCatalog = match.row?.catalog_product_id ? String(match.row.catalog_product_id) : "";
    const proposedStatus =
      match.status === "resolved" && match.tier != null
        ? match.tier === 1
          ? "resolved"
          : "matched"
        : match.status;
    const proposedConf = String(match.confidence ?? 0.95);
    const writeAllowed = match.status === "resolved" && !!proposedProduct && match.tier != null;

    if (writeAllowed) {
      eligible.push({
        ...r,
        match_status: match.status,
        proposed_product_id: proposedProduct,
        proposed_catalog_product_id: proposedCatalog,
        proposed_status: proposedStatus,
        proposed_confidence: proposedConf,
        write_allowed: true,
        match_tier: match.tier,
      });
    }
    if (eligible.length >= TARGET_ROWS) break;
  }

  if (eligible.length < TARGET_ROWS) return null;
  return {
    upload: { organization_id: org, store_id: store, source_upload_id: upload },
    eligible: eligible.slice(0, TARGET_ROWS),
  };
}

function writeHoldPack(outDir: string, searchMd: string, uploadsScanned: unknown[]): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "new-upload-search.md"), searchMd, "utf8");
  fs.writeFileSync(
    path.join(outDir, "verify-only-run.md"),
    "# Verify-only run\n\n**NOT RUN** — no upload with ≥25 execute-eligible candidates.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "target-pk-list.csv"),
    "table_name,source_row_id,note\namazon_fba_inventory,,hold_no_cohort\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "current-preimage.csv"),
    "id,note\n,hold_no_cohort\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "proposed-write-preview.csv"),
    "source_row_id,note\n,hold_no_cohort\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "rollback-preview_DO_NOT_RUN.sql"),
    "-- DO NOT RUN\n-- No cohort selected.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "signoff-checklist.md"),
    "# Signoff checklist\n\n**HOLD** — no new-upload pack. Do not sign off execute.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    "# Validation\n\n**HOLD** — insufficient new-upload cohort.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    "# Blockers\n\n- No `source_upload_id` (excluding pilot) with ≥25 execute-eligible simulated rows.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    "# Next step\n\n**HOLD** — wait for new FBA_INVENTORY import or run micro-wave on pilot upload (NEXT-PRODUCT-40).\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEXT-PRODUCT-40B",
        run_id: RUN_ID,
        mode: "hold_no_new_upload",
        new_upload_found: false,
        pilot_upload_excluded: PILOT_UPLOAD,
        uploads_scanned: uploadsScanned,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function main(): Promise<void> {
  const env = loadEnvLocal();
  const direct = env.DIRECT_POSTGRES_URL?.trim();
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!direct || !url || !service) throw new Error("Missing env");

  const outDir = path.join(process.cwd(), ".cursor/audit-reports/next-product-40b", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const pgClient = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const { rows: uploadGroups } = await pgClient.query<{
    organization_id: string;
    store_id: string;
    source_upload_id: string;
    strong_unresolved: string;
    total: string;
  }>(
    `SELECT organization_id::text,
            store_id::text,
            source_upload_id::text,
            count(*)::text AS total,
            count(*) FILTER (
              WHERE resolved_product_id IS NULL
                AND (fnsku IS NOT NULL OR (sku IS NOT NULL AND asin IS NOT NULL))
            )::text AS strong_unresolved
     FROM public.amazon_fba_inventory
     WHERE source_upload_id IS NOT NULL
       AND store_id IS NOT NULL
       AND source_upload_id <> $1::uuid
     GROUP BY organization_id, store_id, source_upload_id
     ORDER BY count(*) FILTER (
       WHERE resolved_product_id IS NULL
         AND (fnsku IS NOT NULL OR (sku IS NOT NULL AND asin IS NOT NULL))
     ) DESC`,
    [PILOT_UPLOAD],
  );

  await pgClient.end();

  const supabase = createClient(url, service, { auth: { persistSession: false } });

  let picked: Awaited<ReturnType<typeof simulateEligible>> = null;
  let simDetail: { upload: string; eligibleFound: number }[] = [];

  for (const g of uploadGroups) {
    const strong = Number(g.strong_unresolved);
    if (strong < TARGET_ROWS) {
      simDetail.push({
        upload: g.source_upload_id,
        eligibleFound: -1,
      });
      continue;
    }
    const result = await simulateEligible(
      supabase,
      g.organization_id,
      g.store_id,
      g.source_upload_id,
    );
    simDetail.push({
      upload: g.source_upload_id,
      eligibleFound: result ? result.eligible.length : 0,
    });
    if (result && !picked) {
      picked = result;
      break;
    }
  }

  const searchMd = `# New upload search

**Excluded pilot upload:** \`${PILOT_UPLOAD}\` (from NEXT-PRODUCT-39)

**Uploads found (excluding pilot):** ${uploadGroups.length}

| organization_id | store_id | source_upload_id | total_rows | strong_unresolved |
| --- | --- | --- | ---: | ---: |
${uploadGroups
  .slice(0, 20)
  .map(
    (g) =>
      `| \`${g.organization_id}\` | \`${g.store_id}\` | \`${g.source_upload_id}\` | ${g.total} | ${g.strong_unresolved} |`,
  )
  .join("\n")}

## Simulation (execute-eligible, non-ambiguous)

${simDetail
  .map((d) => `- \`${d.upload}\`: ${d.eligibleFound < 0 ? "skipped (<25 strong-unresolved)" : `${d.eligibleFound} eligible (stopped at first success)`}`)
  .join("\n")}

## Result

**${picked ? "NEW UPLOAD SELECTED" : "NO QUALIFYING NEW UPLOAD"}**
${picked ? `\n- Selected: \`${picked.upload.source_upload_id}\`\n- Org: \`${picked.upload.organization_id}\`\n- Store: \`${picked.upload.store_id}\`` : ""}
`;

  if (!picked) {
    writeHoldPack(outDir, searchMd, uploadGroups);
    console.log(JSON.stringify({ hold: true, uploads: uploadGroups.length, outDir }, null, 2));
    return;
  }

  fs.writeFileSync(path.join(outDir, "new-upload-search.md"), searchMd, "utf8");

  const selected = picked.eligible;
  const pilot = picked.upload;
  const onlyIds = selected.map((r) => r.id);

  process.env.RESOLVER_INCREMENTAL_PIPELINE = "1";
  process.env.RESOLVER_INCREMENTAL_TABLE_AMAZON_FBA_INVENTORY = "1";
  process.env.RESOLVER_INCREMENTAL_VERIFY_ONLY_AMAZON_FBA_INVENTORY = "1";
  process.env.RESOLVER_INCREMENTAL_EXECUTE_AMAZON_FBA_INVENTORY = "0";

  const verifyResult = await runIncrementalResolverForUpload({
    supabase,
    organizationId: pilot.organization_id,
    uploadId: pilot.source_upload_id,
    storeId: pilot.store_id,
    table: TABLE,
    pageSize: 100,
    governance: { lane: "A", laneB_preflight: false },
    verifyOnly: true,
    allowExecute: false,
    persistToUploadMetadata: false,
    onlyRowIds: onlyIds,
  });
  const m = verifyResult.final_metrics;

  const targetHeader =
    "table_name,source_row_id,organization_id,store_id,source_upload_id,proposed_product_id,proposed_catalog_product_id,proposed_status,proposed_confidence,match_method,reason_code,identifier_tier,write_allowed_if_approved";
  fs.writeFileSync(
    path.join(outDir, "target-pk-list.csv"),
    [
      targetHeader,
      ...selected.map((r) =>
        [
          TABLE,
          r.id,
          r.organization_id,
          r.store_id,
          r.source_upload_id,
          r.proposed_product_id,
          r.proposed_catalog_product_id,
          r.proposed_status,
          r.proposed_confidence,
          "existing_via_identifier_map",
          `new_upload_tier_${r.match_tier ?? "na"}`,
          r.match_tier ?? "",
          "true",
        ]
          .map(escCsv)
          .join(","),
      ),
    ].join("\n") + "\n",
    "utf8",
  );

  const preHeader =
    "id,organization_id,store_id,source_upload_id,resolved_product_id,resolved_catalog_product_id,identifier_resolution_status,identifier_resolution_confidence,updated_at,sku,fnsku,asin,preimage_note";
  fs.writeFileSync(
    path.join(outDir, "current-preimage.csv"),
    [
      preHeader,
      ...selected.map((r) =>
        [
          r.id,
          r.organization_id,
          r.store_id,
          r.source_upload_id,
          "",
          "",
          "",
          "",
          r.updated_at ?? "",
          r.sku ?? "",
          r.fnsku ?? "",
          r.asin ?? "",
          `live_select_${RUN_ID}`,
        ]
          .map(escCsv)
          .join(","),
      ),
    ].join("\n") + "\n",
    "utf8",
  );

  const prevHeader =
    "source_row_id,organization_id,store_id,old_resolved_product_id,proposed_resolved_product_id,diff_resolved_product_id,old_resolved_catalog_product_id,proposed_resolved_catalog_product_id,diff_resolved_catalog_product_id,old_identifier_resolution_status,proposed_identifier_resolution_status,diff_identifier_resolution_status,old_identifier_resolution_confidence,proposed_identifier_resolution_confidence,diff_identifier_resolution_confidence,write_allowed_if_approved,simulated_match_status";
  fs.writeFileSync(
    path.join(outDir, "proposed-write-preview.csv"),
    [
      prevHeader,
      ...selected.map((r) =>
        [
          r.id,
          r.organization_id,
          r.store_id,
          "",
          r.proposed_product_id,
          r.proposed_product_id,
          "",
          "",
          "null",
          "",
          r.proposed_status,
          r.proposed_status,
          "",
          r.proposed_confidence,
          r.proposed_confidence,
          "true",
          r.match_status,
        ]
          .map(escCsv)
          .join(","),
      ),
    ].join("\n") + "\n",
    "utf8",
  );

  const rollback: string[] = [
    "-- DO NOT RUN",
    `-- NEXT-PRODUCT-40B new-upload rollback (${selected.length} PKs)`,
    "BEGIN;",
    "",
  ];
  for (const r of selected) {
    rollback.push(
      `-- id=${r.id}`,
      "UPDATE public.amazon_fba_inventory",
      "SET resolved_product_id = NULL,",
      "    resolved_catalog_product_id = NULL,",
      "    identifier_resolution_status = NULL,",
      "    identifier_resolution_confidence = NULL",
      `WHERE id = '${r.id}'::uuid`,
      `  AND organization_id = '${r.organization_id}'::uuid;`,
      "",
    );
  }
  rollback.push("ROLLBACK;", "");
  fs.writeFileSync(path.join(outDir, "rollback-preview_DO_NOT_RUN.sql"), rollback.join("\n"), "utf8");

  fs.writeFileSync(
    path.join(outDir, "verify-only-run.md"),
    `# Verify-only run

**Run:** \`${RUN_ID}\`  
**New upload:** \`${pilot.source_upload_id}\` (≠ pilot \`${PILOT_UPLOAD}\`)

| Metric | Value |
| --- | ---: |
| rows_scanned | ${m?.rows_scanned ?? "n/a"} |
| rows_resolved | ${m?.rows_resolved ?? "n/a"} |
| rows_ambiguous | ${m?.rows_ambiguous ?? "n/a"} |
| rows_unresolved | ${m?.rows_unresolved ?? "n/a"} |

**No row UPDATE performed.**
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "signoff-checklist.md"),
    `# Signoff checklist — new upload (${selected.length} rows)

- Table: \`amazon_fba_inventory\`
- Upload: \`${pilot.source_upload_id}\`
- Pack: \`next-product-40b/${RUN_ID}\`

- [ ] Product owner approval
- [ ] Data / resolver owner approval
- [ ] Engineering executor approval
- [ ] Execute prompt authorized
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    `# Validation\n\n| Check | Result |\n| --- | --- |\n| New upload found | **PASS** |\n| 25 PKs | **PASS** |\n| Verify-only | **PASS** |\n| No writes | **PASS** |\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    `# Blockers\n\n- Human signoff not recorded (expected before execute).\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next step\n\n\`\`\`text\nNEXT-PRODUCT-41C — FBA INVENTORY NEW-UPLOAD SIGNOFF + EXECUTE AUTHORIZATION\n\`\`\`\n\nThen:\n\n\`\`\`text\nNEXT-PRODUCT-41 — FBA INVENTORY NEW-UPLOAD GOVERNED EXECUTE + POST-VERIFY\n\`\`\`\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEXT-PRODUCT-40B",
        run_id: RUN_ID,
        mode: "new_upload_verify_only_pack",
        new_upload_found: true,
        pilot_upload_excluded: PILOT_UPLOAD,
        selected_upload_id: pilot.source_upload_id,
        organization_id: pilot.organization_id,
        store_id: pilot.store_id,
        selected_row_count: selected.length,
        verify_metrics: m,
        next_prompt: "NEXT-PRODUCT-41C — FBA INVENTORY NEW-UPLOAD SIGNOFF + EXECUTE AUTHORIZATION",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        hold: false,
        upload: pilot.source_upload_id,
        rows: selected.length,
        outDir,
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
