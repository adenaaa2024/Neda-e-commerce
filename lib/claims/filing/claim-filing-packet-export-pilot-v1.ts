/**
 * PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1
 * Local draft filing packet export — audit folder only, no DB writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { ClaimFilingPacketPreviewV1 } from "./claim-filing-packet-preview-v1";
import { renderClaimFilingPacketPreviewHtml } from "./claim-filing-packet-preview-html";
import {
  assessPdfExportEligibility,
  buildExportFileBaseName,
  buildSampleJsonExportShape,
  SAFETY_LABELS,
  summarizePdfExportEligibility,
} from "./claim-pdf-export-preview-contract-v1";

export const PILOT_OUTPUT_ROOT =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1" as const;

export const REQUIRED_DRAFT_LABELS = [
  SAFETY_LABELS.draft_only.display,
  SAFETY_LABELS.not_submitted_amazon.display,
  SAFETY_LABELS.internal_review.display,
] as const;

export type CaseExportArtifacts = {
  claim_case_id: string;
  family_key_v3: string | null;
  base_name: string;
  case_dir: string;
  files: {
    html: string;
    json: string;
    txt: string;
    pdf: string | null;
  };
  pdf_generated: boolean;
  pdf_skip_reason: string | null;
  draft_labels_verified: boolean;
  eligible: boolean;
};

export function renderClaimFilingPacketTextSummary(args: {
  preview: ClaimFilingPacketPreviewV1;
  exportRunId: string;
}): string {
  const p = args.preview;
  const lines = [
    "=== CLAIM FILING PACKET — DRAFT TEXT SUMMARY ===",
    SAFETY_LABELS.draft_only.display,
    SAFETY_LABELS.not_submitted_amazon.display,
    SAFETY_LABELS.internal_review.display,
    SAFETY_LABELS.no_ai_text.display,
    "",
    `Export run: ${args.exportRunId}`,
    `Case ID: ${p.claim_case_id}`,
    `Family: ${p.family_key_v3 ?? "—"}`,
    `Status: ${p.case_status ?? "—"}`,
    `Source event: ${p.source_event_key ?? "—"} (${p.source_event_date ?? "—"})`,
    `Clean quantity: ${p.clean_quantity ?? "—"}`,
    "",
    "Internal summary:",
    p.internal_filing_summary,
    "",
    `Ready PDF: ${p.readiness.ready_for_pdf_preview ? "yes" : "no"}`,
    `Ready manual: ${p.readiness.ready_for_manual_filing ? "yes" : "no"}`,
    `Warnings: ${p.warnings.join(", ") || "none"}`,
    `Blockers: ${p.blockers.join(", ") || "none"}`,
    "",
    "Money lanes (NULL preserved):",
    `  estimated_amazon_payout: ${p.money_lanes.estimated_amazon_payout ?? "NULL"}`,
    `  observed_reimbursement: ${p.money_lanes.observed_reimbursement ?? "NULL"}`,
    `  internal_cost_loss: ${p.money_lanes.internal_cost_loss ?? "NULL"}`,
    `  recovery_value: ${p.money_lanes.recovery_value ?? "NULL"}`,
    "",
    "DRAFT — NOT SUBMITTED — NOT FOR AMAZON PORTAL UPLOAD",
  ];
  return lines.join("\n");
}

export function verifyDraftLabelsInContent(content: string): boolean {
  return REQUIRED_DRAFT_LABELS.every((label) => content.includes(label));
}

export function verifyMoneyNullPreservationExport(
  previews: ClaimFilingPacketPreviewV1[],
): { pass: boolean; coerced_non_null: number } {
  let coerced = 0;
  for (const p of previews) {
    for (const key of [
      "estimated_amazon_payout",
      "observed_reimbursement",
      "internal_cost_loss",
      "recovery_value",
    ]) {
      const lane = p.money_lanes[key];
      if (lane === 0 && p.evidence_packet_snapshot) {
        const snap = p.evidence_packet_snapshot.money_lanes;
        if (snap && typeof snap === "object" && (snap as Record<string, unknown>)[key] == null) {
          coerced += 1;
        }
      }
    }
  }
  return { pass: coerced === 0, coerced_non_null: coerced };
}

async function tryRenderPdfFromHtml(
  htmlPath: string,
  pdfPath: string,
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const pw = await import("playwright");
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
      await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" },
      });
      return { ok: true, reason: null };
    } finally {
      await browser.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }
}

export async function exportCaseArtifacts(args: {
  preview: ClaimFilingPacketPreviewV1;
  exportRunId: string;
  outputRoot: string;
  attemptPdf: boolean;
}): Promise<CaseExportArtifacts> {
  const eligibility = assessPdfExportEligibility(args.preview);
  if (!eligibility.eligible) {
    throw new Error(`Case ${args.preview.claim_case_id} not eligible for export: ${eligibility.blockers.join(", ")}`);
  }

  const baseName = buildExportFileBaseName({ preview: args.preview, exportRunId: args.exportRunId });
  const caseDir = path.join(args.outputRoot, "cases", args.preview.claim_case_id);
  fs.mkdirSync(caseDir, { recursive: true });

  const htmlPath = path.join(caseDir, `${baseName}.html`);
  const jsonPath = path.join(caseDir, `${baseName}.json`);
  const txtPath = path.join(caseDir, `${baseName}.txt`);
  const pdfPath = path.join(caseDir, `${baseName}.pdf`);

  const html = renderClaimFilingPacketPreviewHtml({
    preview: args.preview,
    exportRunId: args.exportRunId,
  });
  const json = buildSampleJsonExportShape(args.preview, args.exportRunId);
  const txt = renderClaimFilingPacketTextSummary({
    preview: args.preview,
    exportRunId: args.exportRunId,
  });

  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(txtPath, txt, "utf8");

  let pdfGenerated = false;
  let pdfSkipReason: string | null = null;
  if (args.attemptPdf) {
    const pdfResult = await tryRenderPdfFromHtml(htmlPath, pdfPath);
    if (pdfResult.ok && fs.existsSync(pdfPath)) {
      pdfGenerated = true;
    } else {
      pdfSkipReason = pdfResult.reason ?? "pdf_render_failed";
    }
  } else {
    pdfSkipReason = "pdf_attempt_disabled";
  }

  const draftHtml = verifyDraftLabelsInContent(html);
  const draftJson = verifyDraftLabelsInContent(JSON.stringify(json));
  const draftTxt = verifyDraftLabelsInContent(txt);

  return {
    claim_case_id: args.preview.claim_case_id,
    family_key_v3: args.preview.family_key_v3,
    base_name: baseName,
    case_dir: caseDir,
    files: {
      html: htmlPath,
      json: jsonPath,
      txt: txtPath,
      pdf: pdfGenerated ? pdfPath : null,
    },
    pdf_generated: pdfGenerated,
    pdf_skip_reason: pdfSkipReason,
    draft_labels_verified: draftHtml && draftJson && draftTxt,
    eligible: true,
  };
}

export async function exportPilotBatch(args: {
  previews: ClaimFilingPacketPreviewV1[];
  exportRunId: string;
  outputRoot: string;
  attemptPdf?: boolean;
}): Promise<{
  artifacts: CaseExportArtifacts[];
  summary: ReturnType<typeof summarizePdfExportEligibility>;
  by_family: Record<string, number>;
  pdf_generated_count: number;
}> {
  const attemptPdf = args.attemptPdf !== false;
  const artifacts: CaseExportArtifacts[] = [];

  for (const preview of args.previews) {
    artifacts.push(
      await exportCaseArtifacts({
        preview,
        exportRunId: args.exportRunId,
        outputRoot: args.outputRoot,
        attemptPdf,
      }),
    );
  }

  const by_family: Record<string, number> = {};
  for (const a of artifacts) {
    const fam = a.family_key_v3 ?? "unknown";
    by_family[fam] = (by_family[fam] ?? 0) + 1;
  }

  const manifestPath = path.join(args.outputRoot, "manifest.json");
  const csvPath = path.join(args.outputRoot, "summary.csv");

  const csvHeader =
    "claim_case_id,family_key_v3,source_event_key,clean_quantity,ready_for_pdf_preview,ready_for_manual_filing,warning_codes,blocker_codes,export_run_id,html_path,pdf_generated";
  const csvRows = artifacts.map((a, i) => {
    const p = args.previews[i]!;
    return [
      p.claim_case_id,
      p.family_key_v3 ?? "",
      p.source_event_key ?? "",
      p.clean_quantity ?? "",
      p.readiness.ready_for_pdf_preview,
      p.readiness.ready_for_manual_filing,
      p.warnings.join("|"),
      p.blockers.join("|"),
      args.exportRunId,
      a.files.html,
      a.pdf_generated,
    ].join(",");
  });
  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n"), "utf8");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        export_run_id: args.exportRunId,
        generated_case_count: artifacts.length,
        pdf_generated_count: artifacts.filter((a) => a.pdf_generated).length,
        artifacts: artifacts.map((a) => ({
          claim_case_id: a.claim_case_id,
          family_key_v3: a.family_key_v3,
          base_name: a.base_name,
          files: a.files,
          pdf_generated: a.pdf_generated,
          pdf_skip_reason: a.pdf_skip_reason,
          draft_labels_verified: a.draft_labels_verified,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    artifacts,
    summary: summarizePdfExportEligibility(args.previews),
    by_family,
    pdf_generated_count: artifacts.filter((a) => a.pdf_generated).length,
  };
}

export function loadApprovalStatus(approvalPath: string): {
  approved: boolean;
  raw: string;
} {
  if (!fs.existsSync(approvalPath)) {
    return { approved: false, raw: "missing" };
  }
  const raw = fs.readFileSync(approvalPath, "utf8");
  return {
    approved: /APPROVED_CLAIM_PDF_EXPORT_PREVIEW_PILOT_V1\s*=\s*yes/i.test(raw),
    raw: raw.includes("APPROVED_CLAIM_PDF_EXPORT_PREVIEW_PILOT_V1=yes") ? "yes" : "no_or_missing",
  };
}
