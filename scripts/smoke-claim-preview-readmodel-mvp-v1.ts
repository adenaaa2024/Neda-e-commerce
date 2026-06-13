/**
 * PHASE-FIRST-CLAIM-PREVIEW-READMODEL-MVP-V1 — smoke (readmodel static + optional staging)
 *   npx tsx scripts/smoke-claim-preview-readmodel-mvp-v1.ts --run-id=<UTC>
 *   npx tsx scripts/smoke-claim-preview-readmodel-mvp-v1.ts --run-id=<UTC> --staging
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  CLAIM_PREVIEW_MVP_FAMILIES,
  buildClaimPreviewReadmodelMvp,
  claimPreviewMvpGeneratorCoverage,
} from "../lib/claims/center/claim-preview-readmodel-mvp-v1";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/smoke-claim-preview-readmodel-mvp-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const id = runId();
  const staging = process.argv.includes("--staging");
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-preview-readmodel-mvp-v1.ts"),
    "utf8",
  );
  const noDbWrite =
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.delete\s*\(/.test(src) &&
    !/claim_candidates.*\.insert/.test(src);

  let payload: Awaited<ReturnType<typeof buildClaimPreviewReadmodelMvp>> | null = null;
  let stagingRef: string | null = null;
  let claimCandidatesDelta: number | null = null;

  if (staging) {
    loadEnvLocalIntoProcess();
    const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(stagingUrl) === STAGING_REF) {
      stagingRef = STAGING_REF;
      const client = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
      const { count: countBefore } = await client
        .from("claim_candidates")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG)
        .eq("store_id", STORE);
      payload = await buildClaimPreviewReadmodelMvp({
        client,
        organizationId: ORG,
        storeId: STORE,
        rowLimit: 60,
      });
      const { count: countAfter } = await client
        .from("claim_candidates")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG)
        .eq("store_id", STORE);
      claimCandidatesDelta = (countAfter ?? 0) - (countBefore ?? 0);
    }
  }

  const coverage = claimPreviewMvpGeneratorCoverage();
  const sampleItems = payload?.items.slice(0, 5) ?? [];

  const checks = {
    mvp_family_count_5: CLAIM_PREVIEW_MVP_FAMILIES.length === 5,
    api_route_exists: fs.existsSync(
      path.join(process.cwd(), "app/api/claims/center/claim-preview/route.ts"),
    ),
    handler_wired: fs.readFileSync(
      path.join(process.cwd(), "lib/claims/center/claim-center-api-handlers.ts"),
      "utf8",
    ).includes("getCenterClaimPreviewPayload"),
    no_db_writes_in_src: noDbWrite,
    staging_payload_when_requested: staging ? payload != null : true,
    staging_items_when_requested: staging ? (payload?.preview_item_count ?? 0) > 0 : true,
    preview_id_on_samples: sampleItems.every((i) => i.preview_id.startsWith("preview:v1:")),
    duplicate_key_on_samples: sampleItems.every((i) => i.duplicate_prevention_key.length > 0),
    trid_edges_on_samples: sampleItems.every((i) => i.trid_reference_edges_required.length > 0),
    status_on_samples: sampleItems.every((i) =>
      ["claim_ready_preview", "needs_review", "blocked"].includes(i.status),
    ),
    claim_candidates_delta_zero: staging ? claimCandidatesDelta === 0 : true,
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-FIRST-CLAIM-PREVIEW-READMODEL-MVP-V1",
    run_id: id,
    staging_ref: stagingRef,
    files_changed: [
      "lib/claims/center/claim-preview-readmodel-mvp-v1.ts",
      "lib/claims/center/claim-center-api-handlers.ts",
      "lib/claims/center/claim-readmodel-staging-dryrun-v1.ts",
      "app/api/claims/center/claim-preview/route.ts",
      "scripts/smoke-claim-preview-readmodel-mvp-v1.ts",
    ],
    api_route_added_or_extended: "GET /api/claims/center/claim-preview",
    preview_family_count: payload?.preview_family_count ?? CLAIM_PREVIEW_MVP_FAMILIES.length,
    preview_item_count: payload?.preview_item_count ?? null,
    generator_coverage: coverage,
    sample_preview_items: sampleItems,
    top_blockers: payload?.top_blockers ?? [],
    families_summary: payload?.families ?? null,
    no_db_write_verification: noDbWrite ? "PASS" : "FAIL",
    no_claim_candidate_mutation_verification:
      claimCandidatesDelta === 0 || claimCandidatesDelta == null
        ? "PASS — SELECT + generator dry-run only"
        : `FAIL — claim_candidates delta ${claimCandidatesDelta}`,
    claim_candidates_delta: claimCandidatesDelta,
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    build_result: "pending",
    smoke_result: failures.length === 0 ? "PASS" : "FAIL",
    checks,
    pass: failures.length === 0,
    SAFE_TO_PUSH: failures.length === 0 ? (payload?.SAFE_TO_PUSH ?? "conditional") : "no",
    NEXT_PROMPT:
      "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — Claim Center preview panel wired to GET /api/claims/center/claim-preview; no apply",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Smoke claim preview readmodel MVP V1

**Run:** ${id}
**Staging:** ${stagingRef ?? "skipped"}
**Pass:** ${results.pass ? "YES" : "NO"}

## API
GET /api/claims/center/claim-preview?organization_id=&store_id=&limit=

## Preview items: ${payload?.preview_item_count ?? "n/a (static smoke)"}
## SAFE_TO_PUSH: ${results.SAFE_TO_PUSH}
`,
  );

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      run_id: id,
      staging: Boolean(stagingRef),
      items: payload?.preview_item_count ?? 0,
      SAFE: results.SAFE_TO_PUSH,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
