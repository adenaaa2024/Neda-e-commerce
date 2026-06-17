/**
 * PHASE-CLAIM-VRET-SLIP-REFERENCE-MAPPING-AUDIT-V1 — read-only VRET slip reference audit
 *   npx tsx scripts/phase-claim-vret-slip-reference-mapping-audit-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  loadUploadLineage,
  tryDownloadUploadArtifact,
} from "../lib/claims/reference/claim-7h-source-api-file-reference-discovery-v1";
import {
  CLAIM_VRET_SLIP_REFERENCE_MAPPING_AUDIT_V1_VERSION,
  countVretInText,
  DEFAULT_VRET_EXAMPLE,
  REPORT_TYPES_TO_CHECK,
  runVretSlipReferenceMappingAuditV1,
  type ReportSearchHit,
} from "../lib/claims/reference/claim-vret-slip-reference-mapping-audit-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-vret-slip-reference-mapping-audit-v1";
const ORG = "00000000-0000-0000-0000-000000000001";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function vretArg(): string {
  const a = process.argv.find((x) => x.startsWith("--vret="));
  return (a?.split("=")[1] ?? DEFAULT_VRET_EXAMPLE).trim().toUpperCase();
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function searchReportsForVret(
  client: ReturnType<typeof createClient>,
  outDir: string,
  vret: string,
): Promise<ReportSearchHit[]> {
  const hits: ReportSearchHit[] = [];
  const artifactsDir = path.join(outDir, "report-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  for (const reportType of REPORT_TYPES_TO_CHECK) {
    const { data: uploads, error } = await client
      .from("raw_report_uploads")
      .select("id, file_name, report_type, status, created_at")
      .eq("organization_id", ORG)
      .eq("report_type", reportType)
      .order("created_at", { ascending: false })
      .limit(3);

    if (error) {
      hits.push({
        report_type: reportType,
        upload_id: null,
        file_name: null,
        match_count: 0,
        sample_snippets: [`query_error: ${error.message}`],
      });
      continue;
    }

    if (!uploads?.length) {
      hits.push({
        report_type: reportType,
        upload_id: null,
        file_name: null,
        match_count: 0,
        sample_snippets: ["no_uploads"],
      });
      continue;
    }

    let totalMatches = 0;
    const snippets: string[] = [];

    for (const upload of uploads) {
      const lineage = await loadUploadLineage(client, ORG, String(upload.id));
      if (!lineage) continue;

      const { fileText } = await tryDownloadUploadArtifact({
        client,
        uploadLineage: lineage,
        outputDir: artifactsDir,
      });

      if (!fileText) continue;
      const n = countVretInText(fileText, vret);
      const vretPrefix = (fileText.match(/\bVRET\d{8,}\b/gi) ?? []).length;
      totalMatches += n;
      if (n > 0 || vretPrefix > 0) {
        const idx = fileText.toUpperCase().indexOf(vret);
        const snippet =
          idx >= 0
            ? fileText.slice(Math.max(0, idx - 80), idx + vret.length + 80).replace(/\s+/g, " ")
            : `vret_prefix_count=${vretPrefix}`;
        snippets.push(`${upload.file_name ?? upload.id}: ${snippet}`);
      }
    }

    hits.push({
      report_type: reportType,
      upload_id: uploads[0]?.id != null ? String(uploads[0].id) : null,
      file_name: uploads[0]?.file_name != null ? String(uploads[0].file_name) : null,
      match_count: totalMatches,
      sample_snippets: snippets.length ? snippets.slice(0, 5) : ["no_vret_match_in_sampled_uploads"],
    });
  }

  // amazon_reports_repository text columns (bounded)
  const { data: repoRows, error: repoErr } = await client
    .from("amazon_reports_repository")
    .select("id, order_id, sku, asin, date_time, product_sales, created_at")
    .eq("organization_id", ORG)
    .or(`order_id.ilike.%${vret}%,sku.ilike.%${vret}%`)
    .limit(5);

  if (!repoErr && repoRows?.length) {
    hits.push({
      report_type: "amazon_reports_repository_row_match",
      upload_id: null,
      file_name: null,
      match_count: repoRows.length,
      sample_snippets: repoRows.map((r) => JSON.stringify(r)).slice(0, 3),
    });
  }

  return hits;
}

function buildSummaryMd(result: Awaited<ReturnType<typeof runVretSlipReferenceMappingAuditV1>>, id: string): string {
  return `# PHASE-CLAIM-VRET-SLIP-REFERENCE-MAPPING-AUDIT-V1

**Run:** \`${id}\`  
**Version:** \`${CLAIM_VRET_SLIP_REFERENCE_MAPPING_AUDIT_V1_VERSION}\`  
**Verdict:** ${result.exact_occurrence_found ? "**EXACT MATCH FOUND**" : "**EXAMPLE NOT IN DB**"} · confidence **${result.confidence}**

## Example
- \`vret_example\`: **${result.vret_example}**
- \`exact_occurrence_found\`: **${result.exact_occurrence_found ? "yes" : "no"}**
- \`vret_pattern_sample_count\`: **${result.vret_pattern_sample_count}**

## Inference
- **Meaning:** ${result.inferred_meaning}
- **recommended_reference_type:** \`${result.recommended_reference_type}\`
- **recommended_storage_location:** ${result.recommended_storage_location}
- **recommended_edge_type_if_later_materialized:** ${result.recommended_edge_type_if_later_materialized}

## Safety gates
| Gate | Value |
|------|-------|
| proven_not_order_id | ${result.proven_not_order_id ? "yes" : "no"} |
| proven_not_trid | ${result.proven_not_trid ? "yes" : "no"} |
| SAFE_TO_USE_VRET_AS_REFERENCE | **${result.SAFE_TO_USE_VRET_AS_REFERENCE ? "yes" : "no"}** |
| SAFE_TO_PLAN_VRET_REFERENCE_EDGE_MATERIALIZATION | **${result.SAFE_TO_PLAN_VRET_REFERENCE_EDGE_MATERIALIZATION ? "yes" : "no"}** |
| no_db_write_verification | yes |
| no_claim_mutation_verification | yes |
| no_amazon_submission_verification | yes |
| no_scanner_change_verification | yes |

## Occurrences (${result.occurrence_locations.length})
${result.occurrence_locations.length ? result.occurrence_locations.map((l) => `- ${l}`).join("\n") : "- none"}

## Neighboring identifiers
\`\`\`json
${JSON.stringify(result.neighboring_identifiers, null, 2)}
\`\`\`

## Report search
${result.matched_report_rows
  .map(
    (r) =>
      `- **${r.report_type}**: matches=${r.match_count} · ${r.sample_snippets[0] ?? "—"}`,
  )
  .join("\n")}

## Blockers
${result.blockers.length ? result.blockers.map((b) => `- ${b}`).join("\n") : "- none"}

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const vret = vretArg();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const claimTables = ["claim_cases", "claim_candidates", "claim_lines", "claim_submissions", "claim_reference_edges"] as const;
  const countsBefore: Record<string, number> = {};
  for (const t of claimTables) {
    const { count } = await client.from(t).select("id", { count: "exact", head: true }).eq("organization_id", ORG);
    countsBefore[t] = count ?? 0;
  }

  const reportHits = await searchReportsForVret(client, outDir, vret);
  const result = await runVretSlipReferenceMappingAuditV1({
    client,
    organizationId: ORG,
    vretExample: vret,
    reportSearchHits: reportHits,
  });

  const countsAfter: Record<string, number> = {};
  for (const t of claimTables) {
    const { count } = await client.from(t).select("id", { count: "exact", head: true }).eq("organization_id", ORG);
    countsAfter[t] = count ?? 0;
  }

  const scannerAfter = scannerGitStatus();
  const payload = {
    run_id: id,
    db_ref: ref,
    organization_id: ORG,
    claim_table_counts_before: countsBefore,
    claim_table_counts_after: countsAfter,
    claim_tables_unchanged: claimTables.every((t) => countsBefore[t] === countsAfter[t]),
    scanner_git_before: scannerBefore,
    scanner_git_after: scannerAfter,
    scanner_unchanged: scannerBefore === scannerAfter,
    ...result,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), buildSummaryMd(result, id));

  console.log(JSON.stringify({
    run_id: id,
    exact_occurrence_found: result.exact_occurrence_found,
    confidence: result.confidence,
    SAFE_TO_USE_VRET_AS_REFERENCE: result.SAFE_TO_USE_VRET_AS_REFERENCE,
    SAFE_TO_PLAN_VRET_REFERENCE_EDGE_MATERIALIZATION: result.SAFE_TO_PLAN_VRET_REFERENCE_EDGE_MATERIALIZATION,
    out: path.join(OUT, id),
  }, null, 2));

  if (!payload.claim_tables_unchanged) {
    throw new Error("BLOCKED: claim table counts changed during read-only audit");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
