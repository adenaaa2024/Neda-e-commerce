/**
 * Phase 7G — self-contained HTML renderer for claim evidence packets.
 * Index/summary first page with anchors into per-event sections; print-friendly
 * (PDF export is "print to PDF" or a headless renderer in a later phase).
 */
import type {
  ClaimEvidencePacket,
  PacketEventSection,
  PacketWarning,
} from "./claim-evidence-packet-types";

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

function money(v: number | null, currency: string): string {
  return v == null ? "—" : `${currency} ${v.toFixed(2)}`;
}

function warningBlock(warnings: PacketWarning[]): string {
  if (!warnings.length) return "";
  const items = warnings
    .map(
      (w) =>
        `<li><strong>${esc(w.code)}</strong> — ${esc(w.message)} <span class="muted">(${w.candidate_ids.length} line(s))</span></li>`,
    )
    .join("");
  return `<section class="warnings"><h2>Warnings</h2><ul>${items}</ul></section>`;
}

function eventSection(e: PacketEventSection, currency: string): string {
  const timeline = e.timeline
    .map(
      (t) =>
        `<tr><td>${dash(t.at?.slice(0, 19).replace("T", " "))}</td><td>${esc(t.label)}</td><td>${dash(t.detail)}</td></tr>`,
    )
    .join("");
  const photos = e.photos.length
    ? e.photos
        .map(
          (p) =>
            `<li>${p.url ? `<a href="${esc(p.url)}">${esc(p.url)}</a>` : dash(p.storage_path)} <span class="muted">${dash(p.source)}${p.note ? ` · ${esc(p.note)}` : ""}</span></li>`,
        )
        .join("")
    : "<li class='muted'>No photo/file evidence attached.</li>";
  const edges = e.reference_graph.length
    ? e.reference_graph
        .map((g) => {
          const badge =
            g.edge_source === "materialized"
              ? ` <span class="muted">[${esc(g.edge_type ?? "edge")}${g.ambiguity_group_key ? " · ambiguous — operator selection required" : ""}]</span>`
              : "";
          return `<li><code>${esc(g.reference_kind)}</code> → ${esc(g.reference_value)}${badge}</li>`;
        })
        .join("")
    : "<li class='muted'>No reference edges recorded.</li>";
  const snapshot = e.source_report.snapshot
    ? `<pre class="snapshot">${esc(JSON.stringify(e.source_report.snapshot, null, 2)).slice(0, 4000)}</pre>`
    : "<p class='muted'>Source row snapshot unavailable.</p>";

  return `
<section class="event" id="${esc(e.anchor)}">
  <h2>${esc(e.claim_family)} · ${dash(e.physical_event ?? e.claim_reason)}</h2>
  <p class="muted">Candidate ${esc(e.candidate_id)} · source ${esc(e.source_kind)} · <a href="#index">back to index</a></p>

  <h3>Product</h3>
  <table><tr><th>Item</th><th>SKU</th><th>FNSKU</th><th>ASIN</th><th>Product link</th></tr>
  <tr><td>${dash(e.product.item_name)}</td><td>${dash(e.product.sku)}</td><td>${dash(e.product.fnsku)}</td><td>${dash(e.product.asin)}</td><td>${dash(e.product.resolved_product_id)}</td></tr></table>

  <h3>Event</h3>
  <table>
    <tr><th>Reference</th><td>${dash(e.reference.reference_type)} = ${dash(e.reference.reference_id)}</td></tr>
    <tr><th>Quantities</th><td>expected ${dash(e.quantities.expected)} · actual ${dash(e.quantities.actual)} · delta ${dash(e.quantities.delta)}</td></tr>
    <tr><th>Recovery</th><td>${money(e.money.recovery_value, currency)} (COGS/unit ${money(e.money.cogs_unit, currency)})</td></tr>
    <tr><th>Window</th><td>${dash(e.window.event_date)} → deadline ${dash(e.window.dispute_deadline)} · ${dash(e.window.days_remaining)} day(s) remaining · <strong>${esc(e.window.status)}</strong></td></tr>
    <tr><th>Shipment context</th><td>shipment ${dash(e.shipment_context.shipment_scope_key)} → pallet ${dash(e.shipment_context.pallet_id)} → box ${dash(e.shipment_context.package_code ?? e.shipment_context.package_id)} (tracking ${dash(e.shipment_context.tracking_number)})</td></tr>
    <tr><th>Scan notes</th><td>${dash(e.scan_notes)}</td></tr>
  </table>

  ${e.orbit_evidence_summary ? `<h3>ORBIT evidence summary</h3><p class="orbit">${esc(e.orbit_evidence_summary)}</p>` : ""}

  <h3>Timeline</h3>
  <table><tr><th>When</th><th>Event</th><th>Detail</th></tr>${timeline}</table>

  <h3>Photos / files</h3>
  <ul>${photos}</ul>

  <h3>Reference graph (TRID)</h3>
  <ul>${edges}</ul>

  <h3>Source report snapshot (${esc(e.source_report.source_table)} / ${esc(e.source_report.source_row_id)})</h3>
  ${snapshot}
</section>`;
}

export function renderClaimEvidencePacketHtml(packet: ClaimEvidencePacket): string {
  const currency = packet.index.currency;
  const indexRows = packet.index.lines
    .map(
      (l) => `
<tr>
  <td><a href="#${esc(l.anchor)}">${esc(l.product_label)}</a></td>
  <td>${dash(l.sku)}</td><td>${dash(l.fnsku)}</td><td>${dash(l.asin)}</td>
  <td>${esc(l.claim_family)}</td>
  <td>${dash(l.problem_type)}</td>
  <td>${esc(l.source_kind)}</td>
  <td>${dash(l.reference_type)} = ${dash(l.reference_id)}</td>
  <td>${dash(l.units)}</td>
  <td>${money(l.recovery_value, currency)}</td>
  <td>${esc(l.window_status)}</td>
</tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(packet.title)}</title>
<style>
  body { font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 13px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; }
  th, td { border: 1px solid #e3e3e3; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f7f7f7; font-weight: 600; }
  .muted { color: #888; }
  .warnings { border: 1px solid #f0c36d; background: #fff8e6; padding: 8px 14px; border-radius: 8px; }
  .orbit { border-left: 3px solid #0ea5e9; padding-left: 10px; }
  .snapshot { background: #f6f8fa; border: 1px solid #e3e3e3; border-radius: 6px; padding: 10px; font-size: 11px; overflow-x: auto; }
  .event { page-break-before: always; }
  @media print { body { margin: 12mm; } }
</style></head>
<body>
<section id="index">
  <h1>${esc(packet.title)}</h1>
  <p class="muted">Packet ${esc(packet.packet_id)} · composed ${esc(packet.composed_at.slice(0, 19).replace("T", " "))} · ${packet.grouped ? "grouped claim" : "single claim"}${packet.grouping.override_used ? " · mixed grouping confirmed by operator" : ""}</p>
  <table>
    <tr><th>Claim families</th><td>${esc(packet.index.claim_families.join(", "))}</td></tr>
    <tr><th>Total units</th><td>${packet.index.total_units}</td></tr>
    <tr><th>Total recovery value</th><td>${money(packet.index.total_recovery_value, currency)}</td></tr>
    <tr><th>Included lines</th><td>${packet.index.lines.length}</td></tr>
  </table>
  ${warningBlock(packet.warnings)}
  <h2>Included claim lines</h2>
  <table>
    <tr><th>Product</th><th>SKU</th><th>FNSKU</th><th>ASIN</th><th>Family</th><th>Problem</th><th>Source</th><th>Reference</th><th>Units</th><th>Recovery</th><th>Window</th></tr>
    ${indexRows}
  </table>
</section>
${packet.events.map((e) => eventSection(e, currency)).join("\n")}
</body></html>`;
}
