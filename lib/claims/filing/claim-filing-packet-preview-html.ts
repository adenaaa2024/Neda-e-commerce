/**
 * PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1
 * Self-contained HTML renderer for local draft filing packet previews.
 */
import type { ClaimFilingPacketPreviewV1 } from "./claim-filing-packet-preview-v1";
import { SAFETY_LABELS } from "./claim-pdf-export-preview-contract-v1";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dash(v: unknown): string {
  const s = String(v ?? "").trim();
  return s ? esc(s) : "—";
}

function money(v: unknown, currency: string): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `${currency} ${n.toFixed(2)}` : "—";
}

function row(label: string, value: unknown): string {
  return `<tr><th>${esc(label)}</th><td>${dash(value)}</td></tr>`;
}

function warningList(warnings: string[]): string {
  if (!warnings.length) return "<p class='muted'>No warnings.</p>";
  return `<ul class="warnings-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`;
}

function blockerList(blockers: string[]): string {
  if (!blockers.length) return "<p class='muted'>No blockers.</p>";
  return `<ul class="blockers-list">${blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
}

export function renderClaimFilingPacketPreviewHtml(args: {
  preview: ClaimFilingPacketPreviewV1;
  exportRunId: string;
}): string {
  const p = args.preview;
  const moneyLanes = p.money_lanes;
  const currency = String(moneyLanes.currency ?? "USD");
  const product = p.product_identity;
  const att = p.operator_attestation;
  const dateGate = p.date_gate ?? {};

  const refEdges = p.reference_edges.length
    ? p.reference_edges
        .map(
          (e) =>
            `<li><strong>${dash(e.edge_type)}</strong> · ${dash(e.reference_kind)}:${dash(e.reference_value)}</li>`,
        )
        .join("")
    : "<li class='muted'>No reference edges.</li>";

  const candidateIds = p.line_summary.candidate_ids
    .map((id) => `<li class="mono">${esc(id)}</li>`)
    .join("");
  const lineIds = p.line_summary.claim_line_ids
    .map((id) => `<li class="mono">${esc(id)}</li>`)
    .join("");

  const draftBanner = `
<div class="draft-banner" role="status">
  <strong>${esc(SAFETY_LABELS.draft_only.display)}</strong>
  · ${esc(SAFETY_LABELS.not_submitted_amazon.display)}
  · ${esc(SAFETY_LABELS.internal_review.display)}
</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Internal Review Packet — ${dash(p.family_key_v3)} — ${esc(p.claim_case_id.slice(0, 8))} — DRAFT</title>
<style>
  body { font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; }
  th, td { border: 1px solid #e3e3e3; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f7f7f7; font-weight: 600; width: 28%; }
  .muted { color: #888; }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
  .draft-banner { background: #fef3c7; border: 2px solid #f59e0b; color: #92400e; padding: 10px 14px; border-radius: 8px; margin-bottom: 20px; font-weight: 600; }
  .draft-footer { margin-top: 32px; padding-top: 12px; border-top: 1px dashed #ccc; font-size: 11px; color: #666; }
  .summary { background: #f6f8fa; border: 1px solid #e3e3e3; border-radius: 6px; padding: 12px; }
  .warnings-list li { color: #92400e; }
  .blockers-list li { color: #991b1b; }
  @media print { .draft-banner { position: fixed; top: 0; left: 0; right: 0; } body { margin-top: 48px; } }
</style></head>
<body>
${draftBanner}
<h1>Internal Review Packet</h1>
<p class="muted">Case ${esc(p.claim_case_id)} · export ${esc(args.exportRunId)} · composed ${esc(new Date().toISOString().slice(0, 19).replace("T", " "))}</p>

<h2>Cover summary</h2>
<div class="summary">${esc(p.internal_filing_summary)}</div>
<table>
  ${row("Ready for PDF preview", p.readiness.ready_for_pdf_preview ? "Yes" : "No")}
  ${row("Ready for manual filing", p.readiness.ready_for_manual_filing ? "Yes" : "No")}
  ${row("Pilot case run", p.pilot_case_run_id)}
  ${row("Intake run", p.intake_run_id)}
</table>

<h2>Case identity</h2>
<table>
  ${row("Claim case ID", p.claim_case_id)}
  ${row("Idempotency key", p.case_idempotency_key)}
  ${row("Status", p.case_status)}
  ${row("Claim family", p.claim_family)}
  ${row("Claim source", p.claim_source)}
  ${row("Claim subtype", p.claim_subtype)}
  ${row("Family V3", p.family_key_v3)}
</table>

<h2>Claim lines &amp; candidates</h2>
<table>
  ${row("Line status", p.line_summary.line_status)}
  ${row("Quantity expected", p.line_summary.quantity_expected)}
  ${row("Clean quantity", p.clean_quantity)}
  ${row("Source event key", p.source_event_key)}
  ${row("Source event date", p.source_event_date)}
</table>
<p><strong>Candidate IDs</strong></p><ul>${candidateIds}</ul>
<p><strong>Claim line IDs</strong></p><ul>${lineIds}</ul>

<h2>Product identity</h2>
<table>
  ${row("ASIN", product.asin)}
  ${row("FNSKU", product.fnsku)}
  ${row("SKU", product.sku)}
  ${row("Resolved product", product.resolved_product_id)}
</table>

<h2>Evidence summary</h2>
<div class="summary">${dash(p.evidence_summary ?? p.internal_filing_summary)}</div>

<h2>Reference edges</h2>
<ul>${refEdges}</ul>

<h2>Date gate proof</h2>
<table>
  ${row("Date gate passed", dateGate.date_gate_passed)}
  ${row("Source event date", dateGate.source_event_date ?? p.source_event_date)}
  ${row("Effective date source", dateGate.effective_date_source)}
  ${row("Effective date value", dateGate.effective_date_value)}
</table>

<h2>Operator attestation</h2>
<table>
  ${row("Attested", att.attested ? "Yes" : "No")}
  ${row("Attested by", att.attested_by)}
  ${row("Attested at", att.attested_at)}
</table>

<h2>Money lanes</h2>
<table>
  ${row("Estimated Amazon payout", money(moneyLanes.estimated_amazon_payout, currency))}
  ${row("Observed reimbursement", money(moneyLanes.observed_reimbursement, currency))}
  ${row("Internal cost loss", money(moneyLanes.internal_cost_loss, currency))}
  ${row("Recovery value", money(moneyLanes.recovery_value, currency))}
  ${row("Expected amount", money(moneyLanes.expected_amount, currency))}
  ${row("Sale price (display only)", money(moneyLanes.sale_price_display_only, currency))}
</table>

<h2>Warnings</h2>
${warningList(p.warnings)}

<h2>Blockers</h2>
${blockerList(p.blockers)}

<div class="draft-footer">
  <p><strong>DRAFT — NOT SUBMITTED</strong> · ${esc(SAFETY_LABELS.no_ai_text.display)}</p>
  <p>Internal filing draft text (not for Amazon submission): ${esc(p.amazon_facing_draft_text)}</p>
</div>
</body></html>`;
}
