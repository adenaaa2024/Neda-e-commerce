# Reusable PDF/report service
"""
Standalone PDF / report-generation helpers extracted from claim_agent.py.

Public API
----------
generate_claim_report(claim_data, output_dir=None) -> str
    Build a single-claim human-readable PDF and return its absolute path.

generate_bulk_report_pdf(claim_data, output_dir=None, supabase_client=None) -> str
    Build a two-page "claims-bulk-report" evidence PDF and return its path.

All other symbols in this module are private helpers (_-prefixed).
"""

from __future__ import annotations

import datetime
import json as _json
import os
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# reportlab — PDF generation (pip install reportlab)
from reportlab.lib import colors as _rl_colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    PageBreak,
    PageTemplate,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_env_dir = Path(__file__).resolve().parent
_env_file = _env_dir / ".env"
load_dotenv(dotenv_path=_env_file)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_LOG_PREFIX = "[claim-report-service]"


def _log(msg: str) -> None:
    print(f"{_LOG_PREFIX} {msg}", flush=True)


# ---------------------------------------------------------------------------
# Output directory
# ---------------------------------------------------------------------------

#: Default directory for generated claim PDFs.  Falls back to the OS temp
#: dir when the env var is absent.
_PDF_OUTPUT_DIR: str = os.getenv("CLAIM_PDF_OUTPUT_DIR") or tempfile.gettempdir()

# ---------------------------------------------------------------------------
# Supabase logo constants
# ---------------------------------------------------------------------------

_LOGO_BUCKET = "claim-reports"
_LOGO_STORAGE_PATH = "files/logos/logo-amazon.jpeg"

# ---------------------------------------------------------------------------
# Bulk-report brand / colour constants
# ---------------------------------------------------------------------------

_COMPANY_NAME = "Sam Distribution Inc"
_DOC_SUBTITLE = "FBA claim submission \u00b7 Seller reimbursement evidence"
_FOOTER_BRAND = "E-commerce OS"

_C_NAVY   = _rl_colors.HexColor("#1a1a2e")
_C_AMZN   = _rl_colors.HexColor("#FF9900")
_C_DARK   = _rl_colors.HexColor("#232f3e")
_C_GREY_L = _rl_colors.HexColor("#f2f3f4")
_C_GREY_B = _rl_colors.HexColor("#cccccc")
_C_MID_G  = _rl_colors.HexColor("#666666")
_C_WHITE  = _rl_colors.white
_C_TEXT   = _rl_colors.HexColor("#111111")

_HEADER_H: float = 2.8 * cm
_FOOTER_H: float = 0.9 * cm


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def _safe_text(val: Any, fallback: str = "N/A", max_len: int = 2000) -> str:
    """
    Convert *val* to a printable, unicode-safe string.

    * None / empty → *fallback*
    * Strips control characters (keeps newlines/tabs)
    * Truncates to *max_len* characters
    """
    if val is None:
        return fallback
    try:
        s = str(val).strip()
    except Exception:
        return fallback
    if not s:
        return fallback
    cleaned = "".join(
        ch for ch in s
        if ch in ("\n", "\t") or not unicodedata.category(ch).startswith("C")
    )
    cleaned = cleaned.strip()
    if not cleaned:
        return fallback
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len] + "… [truncated]"
    return cleaned


def _xml_esc(text: str) -> str:
    """Escape XML entities so ReportLab Paragraph doesn't choke on raw data."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# Claim-data normalisation
# ---------------------------------------------------------------------------

def _flatten_claim_data_for_report(claim_data: dict[str, Any]) -> dict[str, str]:
    """
    Normalize a claim_submissions row (or any claim dict) into a flat
    {label: value} mapping suitable for PDF rendering.

    Handles deeply nested structures; never raises.
    """
    flat: dict[str, str] = {}

    flat["Submission ID"] = _safe_text(claim_data.get("id") or claim_data.get("submission_id"))
    flat["Organization ID"] = _safe_text(claim_data.get("org_id") or claim_data.get("organization_id"))
    flat["Status"] = _safe_text(claim_data.get("status"))

    order_id: str = "N/A"
    for key in ("amazon_order_id", "order_id", "amazonOrderId"):
        v = claim_data.get(key)
        if isinstance(v, str) and v.strip():
            order_id = v.strip()
            break
    if order_id == "N/A":
        payload = claim_data.get("source_payload")
        if isinstance(payload, dict):
            for key in ("amazon_order_id", "amazonOrderId", "order_id"):
                v = payload.get(key)
                if isinstance(v, str) and v.strip():
                    order_id = v.strip()
                    break
    if order_id == "N/A":
        ret = claim_data.get("returns")
        if isinstance(ret, list) and ret:
            ret = ret[0]
        if isinstance(ret, dict):
            v = ret.get("order_id")
            if isinstance(v, str) and v.strip():
                order_id = v.strip()
    flat["Amazon Order ID"] = order_id

    ct = claim_data.get("claim_type") or claim_data.get("type")
    if not ct:
        payload = claim_data.get("source_payload")
        if isinstance(payload, dict):
            ct = payload.get("claim_type") or payload.get("type")
    flat["Claim Type"] = _safe_text(ct)

    flat["Created At"] = _safe_text(
        claim_data.get("created_at") or claim_data.get("created")
    )
    flat["Updated At"] = _safe_text(
        claim_data.get("updated_at") or claim_data.get("updated")
    )

    notes = claim_data.get("notes") or claim_data.get("note") or claim_data.get("description")
    flat["Notes / Description"] = _safe_text(notes)

    ref = (
        claim_data.get("reference_text")
        or claim_data.get("reference_number")
        or claim_data.get("reference")
    )
    flat["Reference Numbers"] = _safe_text(ref)

    evidence = claim_data.get("evidence")
    if isinstance(evidence, dict):
        flat["Evidence"] = _safe_text(
            evidence.get("description") or evidence.get("summary") or str(evidence)
        )
    elif evidence is not None:
        flat["Evidence"] = _safe_text(evidence)
    else:
        flat["Evidence"] = "N/A"

    flat["Amazon Case ID"] = _safe_text(
        claim_data.get("amazon_case_id") or claim_data.get("case_id")
    )

    flat["Report URL"] = _safe_text(claim_data.get("report_url"))

    payload = claim_data.get("source_payload")
    if isinstance(payload, dict):
        try:
            payload_str = _json.dumps(payload, indent=2, ensure_ascii=False)
        except Exception:
            payload_str = str(payload)
        flat["Source Payload (excerpt)"] = _safe_text(payload_str, max_len=800)
    else:
        flat["Source Payload (excerpt)"] = _safe_text(payload, max_len=800)

    return flat


def _build_claim_report_lines(flat: dict[str, str]) -> list[tuple[str, str]]:
    """
    Return an ordered list of (label, value) pairs for rendering in the PDF.

    Fields are grouped by importance so the most critical info appears first.
    Fields whose value is 'N/A' are still included but de-emphasised at render
    time so the reader can see that the field was checked.
    """
    priority_keys = [
        "Amazon Order ID",
        "Claim Type",
        "Submission ID",
        "Organization ID",
        "Status",
        "Amazon Case ID",
        "Created At",
        "Updated At",
        "Reference Numbers",
        "Notes / Description",
        "Evidence",
        "Report URL",
        "Source Payload (excerpt)",
    ]
    lines: list[tuple[str, str]] = []
    seen: set[str] = set()
    for k in priority_keys:
        if k in flat:
            lines.append((k, flat[k]))
            seen.add(k)
    for k, v in flat.items():
        if k not in seen:
            lines.append((k, v))
    return lines


# ---------------------------------------------------------------------------
# Bulk-report field extraction
# ---------------------------------------------------------------------------

def _extract_bulk_report_fields(claim_data: dict[str, Any]) -> dict[str, Any]:
    """
    Normalise a ``claim_submissions`` row (or equivalent dict) into a flat
    mapping ready for the bulk-report PDF.  Never raises.
    """
    payload: dict = claim_data.get("source_payload") or {}

    item_name = _safe_text(
        claim_data.get("item_name") or payload.get("item_name")
        or payload.get("title") or payload.get("product_name") or payload.get("name"),
        fallback="—",
    )

    order_id = _safe_text(
        claim_data.get("amazon_order_id") or claim_data.get("order_id")
        or payload.get("amazon_order_id") or payload.get("order_id")
        or payload.get("amazonOrderId"),
        fallback="—",
    )

    claim_type = _safe_text(
        claim_data.get("claim_type") or payload.get("claim_type")
        or payload.get("defect_type") or payload.get("type"),
        fallback="FBA_CLAIM",
    )

    status_raw     = _safe_text(claim_data.get("status"), fallback="ready_to_send")
    status_display = status_raw.replace("_", " ").title()

    claim_id = _safe_text(
        claim_data.get("id") or claim_data.get("submission_id"), fallback="—"
    )

    asin  = _safe_text(claim_data.get("asin")  or payload.get("asin"),  fallback="—")
    sku   = _safe_text(claim_data.get("sku")   or payload.get("sku"),   fallback="—")
    fnsku = _safe_text(claim_data.get("fnsku") or payload.get("fnsku"), fallback="—")

    pallet_num = _safe_text(
        payload.get("pallet_number") or payload.get("pallet_id") or payload.get("pallet"),
        fallback="—",
    )
    package_num = _safe_text(
        payload.get("package_number") or payload.get("package_id") or payload.get("package"),
        fallback="—",
    )
    tracking = _safe_text(
        payload.get("tracking") or payload.get("tracking_number") or payload.get("trackingNumber"),
        fallback="—",
    )
    carrier = _safe_text(
        payload.get("carrier") or payload.get("carrier_name"), fallback="—"
    )

    amount_raw   = _safe_text(
        payload.get("amount") or payload.get("reimbursement_amount")
        or claim_data.get("amount"), fallback="—",
    )
    filed_amount = _safe_text(
        payload.get("filed_amount") or payload.get("amount")
        or claim_data.get("amount"), fallback="—",
    )

    case_id     = _safe_text(
        claim_data.get("amazon_case_id") or claim_data.get("case_id"), fallback="—"
    )
    link_status = _safe_text(payload.get("link_status"), fallback="—")

    notes = _safe_text(
        claim_data.get("notes") or claim_data.get("description")
        or payload.get("notes") or payload.get("comments"),
        fallback=(
            "Add operator notes, carrier context, or Seller Central "
            "case references here (optional)."
        ),
    )

    photo_labels: list[str] = list(payload.get("photo_labels") or [
        "Damaged Outer Box (closed)", "Outer Box", "Opened Box",
        "Box Label", "Packing Slip / Manifest (package)", "Defective Item Condition",
        "Expiry Label",
    ])

    return {
        "item_name":      item_name,
        "order_id":       order_id,
        "claim_type":     claim_type,
        "status_display": status_display,
        "claim_id":       claim_id,
        "asin":           asin,
        "sku":            sku,
        "fnsku":          fnsku,
        "pallet_num":     pallet_num,
        "package_num":    package_num,
        "tracking":       tracking,
        "carrier":        carrier,
        "amount":         amount_raw,
        "filed_amount":   filed_amount,
        "case_id":        case_id,
        "link_status":    link_status,
        "notes":          notes,
        "photo_labels":   photo_labels,
    }


# ---------------------------------------------------------------------------
# Supabase logo download (PDF asset only — no DB sync)
# ---------------------------------------------------------------------------

def _download_logo_from_supabase(supabase_client=None) -> str | None:
    """
    Download ``claim-reports/files/logos/logo-amazon.jpeg`` from Supabase
    Storage to a temporary local JPEG file.

    Parameters
    ----------
    supabase_client:
        An already-initialised Supabase ``Client``.  When *None* a new client
        is created from ``SUPABASE_URL`` / ``SUPABASE_SERVICE_ROLE_KEY`` env vars.

    Returns
    -------
    str | None
        Absolute path of the temporary file, or *None* on any failure.
        Never raises.
    """
    client = supabase_client
    if client is None:
        url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not (url and key):
            _log("Logo: missing Supabase credentials — skipping logo download.")
            return None
        try:
            from supabase import create_client as _cc
            client = _cc(url, key)
        except Exception as _e:
            _log(f"Logo: could not create Supabase client: {_e}")
            return None

    try:
        raw = client.storage.from_(_LOGO_BUCKET).download(_LOGO_STORAGE_PATH)
        if not raw:
            _log("Logo: empty response from Supabase Storage.")
            return None
        fd, tmp = tempfile.mkstemp(suffix=".jpeg", prefix="claim_logo_")
        os.close(fd)
        with open(tmp, "wb") as fh:
            fh.write(raw)
        _log(f"Logo downloaded → {tmp!r}")
        return tmp
    except Exception as exc:
        _log(f"Logo download failed ({_LOGO_BUCKET}/{_LOGO_STORAGE_PATH}): {exc}")
        return None


# ---------------------------------------------------------------------------
# Bulk-report canvas helpers
# ---------------------------------------------------------------------------

def _draw_amazon_text(canvas: Any, x: float, y: float) -> None:
    """Render 'amazon' in the brand orange as a logo text-placeholder."""
    canvas.setFillColor(_C_AMZN)
    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawString(x, y, "amazon")


def _draw_bulk_report_chrome(
    canvas: Any,
    doc: Any,
    logo_path: str | None,
    fields: dict[str, Any],
) -> None:
    """
    Draw the repeating header band and page-specific footer on the canvas.
    Registered as the ``onPage`` callback so it fires on every page.
    """
    W, H = A4
    page_num: int = doc.page

    canvas.saveState()

    canvas.setFillColor(_C_NAVY)
    canvas.rect(0, H - _HEADER_H, W, _HEADER_H, fill=1, stroke=0)

    canvas.setFillColor(_C_WHITE)
    canvas.setFont("Helvetica-Bold", 13)
    canvas.drawString(2 * cm, H - 1.35 * cm, _COMPANY_NAME)

    canvas.setFillColor(_rl_colors.HexColor("#bbbbbb"))
    canvas.setFont("Helvetica", 8.5)
    canvas.drawString(2 * cm, H - 1.95 * cm, _DOC_SUBTITLE)

    badge_w = 2.4 * cm
    badge_h = 0.38 * cm
    badge_x = W - 2 * cm - 3.8 * cm - badge_w - 0.3 * cm
    badge_y = H - 0.78 * cm
    canvas.setFillColor(_C_AMZN)
    canvas.roundRect(badge_x, badge_y - badge_h, badge_w, badge_h, 2, fill=1, stroke=0)
    canvas.setFillColor(_C_WHITE)
    canvas.setFont("Helvetica-Bold", 6.5)
    canvas.drawCentredString(
        badge_x + badge_w / 2, badge_y - badge_h + 0.07 * cm, "MARKETPLACE"
    )

    logo_w = 3.0 * cm
    logo_h = _HEADER_H - 0.6 * cm
    logo_x = W - 2 * cm - logo_w
    logo_y = H - _HEADER_H + 0.3 * cm

    if logo_path and os.path.isfile(logo_path):
        try:
            canvas.drawImage(
                logo_path,
                logo_x, logo_y,
                width=logo_w, height=logo_h,
                preserveAspectRatio=True,
            )
        except Exception:
            _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)
    else:
        _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)

    canvas.setStrokeColor(_C_GREY_B)
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, _FOOTER_H + 0.15 * cm, W - 2 * cm, _FOOTER_H + 0.15 * cm)

    if page_num == 1:
        footer_text = f"Page 1 \u00b7 Master summary \u00b7 {_FOOTER_BRAND}"
    else:
        footer_text = (
            f"Item 1 of 1 \u00b7 {fields['claim_id']} "
            f"\u00b7 Page {page_num} \u00b7 {_FOOTER_BRAND}"
        )

    canvas.setFillColor(_C_MID_G)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawCentredString(W / 2, 0.3 * cm, footer_text)

    canvas.restoreState()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_claim_report(
    claim_data: dict[str, Any],
    output_dir: str | None = None,
) -> str:
    """
    Build a human-readable PDF claim report and write it to disk.

    Parameters
    ----------
    claim_data:
        Any dict that carries claim information — typically a
        ``claim_submissions`` Supabase row, but also accepts the loose dicts
        used elsewhere in the system.
    output_dir:
        Directory to write the PDF into.  Defaults to ``CLAIM_PDF_OUTPUT_DIR``
        env var or the OS temporary directory.

    Returns
    -------
    str
        Absolute path of the generated PDF file.

    Raises
    ------
    RuntimeError
        When the PDF cannot be written after all retry attempts.
    """
    _log("Generating claim PDF report…")

    out_dir = output_dir or _PDF_OUTPUT_DIR
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as exc:
        _log(f"Cannot create PDF output dir {out_dir!r}: {exc} — falling back to tempdir.")
        out_dir = tempfile.gettempdir()

    flat = _flatten_claim_data_for_report(claim_data)
    sub_id = flat.get("Submission ID", "unknown").replace("/", "-").replace("\\", "-")
    order_id = flat.get("Amazon Order ID", "unknown").replace("/", "-").replace("\\", "-")
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"claim-report-{sub_id}-{order_id}-{ts}.pdf"
    for ch in r'<>:"|?*':
        filename = filename.replace(ch, "_")
    pdf_path = os.path.abspath(os.path.join(out_dir, filename))

    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2.5 * cm,
        bottomMargin=2.5 * cm,
        title=f"Claim Report — {order_id}",
        author="ecommerce-os claim-agent",
    )

    styles = getSampleStyleSheet()
    style_title = ParagraphStyle(
        "ClaimTitle",
        parent=styles["Title"],
        fontSize=18,
        spaceAfter=6,
        textColor=_rl_colors.HexColor("#1a1a2e"),
    )
    style_subtitle = ParagraphStyle(
        "ClaimSubtitle",
        parent=styles["Normal"],
        fontSize=10,
        textColor=_rl_colors.HexColor("#555555"),
        spaceAfter=12,
    )
    style_section = ParagraphStyle(
        "SectionHeader",
        parent=styles["Heading2"],
        fontSize=11,
        textColor=_rl_colors.HexColor("#16213e"),
        spaceBefore=10,
        spaceAfter=4,
        borderPad=2,
    )
    style_label = ParagraphStyle(
        "FieldLabel",
        parent=styles["Normal"],
        fontSize=9,
        textColor=_rl_colors.HexColor("#333333"),
        fontName="Helvetica-Bold",
    )
    style_value = ParagraphStyle(
        "FieldValue",
        parent=styles["Normal"],
        fontSize=9,
        textColor=_rl_colors.HexColor("#111111"),
        leading=13,
        wordWrap="CJK",
    )
    style_na = ParagraphStyle(
        "FieldNA",
        parent=style_value,
        textColor=_rl_colors.HexColor("#aaaaaa"),
    )

    story: list = []

    story.append(Paragraph("Amazon Seller Central — Claim Report", style_title))
    story.append(
        Paragraph(
            f"Generated: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC",
            style_subtitle,
        )
    )
    story.append(HRFlowable(width="100%", thickness=1.5, color=_rl_colors.HexColor("#1a1a2e")))
    story.append(Spacer(1, 0.4 * cm))

    summary_pairs = [
        ("Amazon Order ID", flat.get("Amazon Order ID", "N/A")),
        ("Claim Type", flat.get("Claim Type", "N/A")),
        ("Submission ID", flat.get("Submission ID", "N/A")),
        ("Organization ID", flat.get("Organization ID", "N/A")),
        ("Status", flat.get("Status", "N/A")),
        ("Amazon Case ID", flat.get("Amazon Case ID", "N/A")),
        ("Created At", flat.get("Created At", "N/A")),
        ("Updated At", flat.get("Updated At", "N/A")),
    ]
    story.append(Paragraph("Summary", style_section))
    tbl_data = [
        [
            Paragraph(_safe_text(lbl), style_label),
            Paragraph(_safe_text(val) if val != "N/A" else "—", style_na if val == "N/A" else style_value),
        ]
        for lbl, val in summary_pairs
    ]
    tbl = Table(tbl_data, colWidths=[4.5 * cm, None], hAlign="LEFT")
    tbl.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), _rl_colors.HexColor("#eef1f7")),
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [_rl_colors.white, _rl_colors.HexColor("#f7f9fc")]),
            ("GRID", (0, 0), (-1, -1), 0.4, _rl_colors.HexColor("#cccccc")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ])
    )
    story.append(tbl)
    story.append(Spacer(1, 0.5 * cm))

    detail_keys = [
        "Reference Numbers",
        "Notes / Description",
        "Evidence",
        "Report URL",
        "Source Payload (excerpt)",
    ]
    story.append(Paragraph("Details", style_section))
    story.append(HRFlowable(width="100%", thickness=0.5, color=_rl_colors.HexColor("#cccccc")))
    story.append(Spacer(1, 0.2 * cm))

    for key in detail_keys:
        val = flat.get(key, "N/A")
        story.append(Paragraph(key, style_label))
        escaped = val.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        escaped_br = escaped.replace("\n", "<br/>")
        st = style_na if val == "N/A" else style_value
        story.append(Paragraph(escaped_br if val != "N/A" else "—", st))
        story.append(Spacer(1, 0.25 * cm))

    rendered = {
        "Amazon Order ID", "Claim Type", "Submission ID", "Organization ID",
        "Status", "Amazon Case ID", "Created At", "Updated At",
        "Reference Numbers", "Notes / Description", "Evidence",
        "Report URL", "Source Payload (excerpt)",
    }
    extras = [(k, v) for k, v in flat.items() if k not in rendered]
    if extras:
        story.append(Paragraph("Additional Fields", style_section))
        story.append(HRFlowable(width="100%", thickness=0.5, color=_rl_colors.HexColor("#cccccc")))
        story.append(Spacer(1, 0.2 * cm))
        for key, val in extras:
            story.append(Paragraph(key, style_label))
            escaped = val.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            escaped_br = escaped.replace("\n", "<br/>")
            st = style_na if val == "N/A" else style_value
            story.append(Paragraph(escaped_br if val != "N/A" else "—", st))
            story.append(Spacer(1, 0.25 * cm))

    story.append(Spacer(1, 0.5 * cm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=_rl_colors.HexColor("#cccccc")))
    story.append(
        Paragraph(
            f"ecommerce-os · claim-agent · {datetime.datetime.now().strftime('%Y-%m-%d')}",
            style_subtitle,
        )
    )

    try:
        doc.build(story)
    except Exception as exc:
        raise RuntimeError(f"[claim-report-service] PDF build failed for {pdf_path!r}: {exc}") from exc

    if not os.path.isfile(pdf_path):
        raise RuntimeError(f"[claim-report-service] PDF file missing after build: {pdf_path!r}")

    _log(f"Claim PDF generated at: {pdf_path}")
    return pdf_path


def generate_bulk_report_pdf(
    claim_data: dict[str, Any],
    output_dir: str | None = None,
    supabase_client=None,
) -> str:
    """
    Build a two-page PDF evidence package that mimics the
    ``claims-bulk-report`` format and write it to disk.

    * **Page 1** — Master summary: batch-selection header, intro paragraph,
      and a line-item table (Item Name / Order ID / Defect Type / Status /
      Photo / Detail).
    * **Page 2** — Detail view: Identifiers (ASIN, FNSKU, SKU), Logistics
      (pallet, package, tracking, carrier), Claim info (type, order, amount,
      case ID), operator notes, and a photo-placeholder grid.

    The company logo is fetched from Supabase Storage
    (``claim-reports/files/logos/logo-amazon.jpeg``).  If the download fails
    for any reason, the word *amazon* is rendered in Amazon orange as a
    text placeholder so the PDF is always generated.

    Parameters
    ----------
    claim_data:
        A ``claim_submissions`` Supabase row or any dict containing claim
        information.
    output_dir:
        Target directory.  Defaults to the ``CLAIM_PDF_OUTPUT_DIR`` env var
        or the OS temporary directory.
    supabase_client:
        Optional already-initialised Supabase ``Client`` (avoids a redundant
        ``create_client`` call during bulk processing).

    Returns
    -------
    str
        Absolute path of the generated PDF file.

    Raises
    ------
    RuntimeError
        When the PDF cannot be written after the build attempt.
    """
    _log("Generating bulk-report PDF (claims-bulk-report format, 2 pages)…")

    out_dir = output_dir or _PDF_OUTPUT_DIR
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError:
        out_dir = tempfile.gettempdir()

    fields = _extract_bulk_report_fields(claim_data)
    ts     = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_oid = fields["order_id"]
    for ch in r'<>:"/\\|?*':
        safe_oid = safe_oid.replace(ch, "-")
    filename = f"claim-bulk-{safe_oid}-{ts}.pdf"
    pdf_path = os.path.abspath(os.path.join(out_dir, filename))

    logo_tmp: str | None = None
    try:
        logo_tmp = _download_logo_from_supabase(supabase_client)
    except Exception as _le:
        _log(f"Logo download error (non-fatal): {_le}")

    _ss = getSampleStyleSheet()

    def _mk(name: str, **kw: Any) -> ParagraphStyle:
        return ParagraphStyle(name, parent=_ss["Normal"], **kw)

    sty_pkg_title  = _mk("BR_PkgTitle",  fontSize=12, fontName="Helvetica-Bold",
                          textColor=_C_DARK,  spaceAfter=2, spaceBefore=4)
    sty_pkg_sub    = _mk("BR_PkgSub",    fontSize=8,  textColor=_C_MID_G, spaceAfter=8)
    sty_intro      = _mk("BR_Intro",     fontSize=9.5, textColor=_C_TEXT,
                          spaceAfter=6, leading=14)
    sty_sec_lbl    = _mk("BR_SecLbl",    fontSize=9,  fontName="Helvetica-Bold",
                          textColor=_C_TEXT,  spaceAfter=3)
    sty_body       = _mk("BR_Body",      fontSize=9,  textColor=_C_TEXT,
                          spaceAfter=3, leading=13)
    sty_small      = _mk("BR_Small",     fontSize=8,  textColor=_C_MID_G, spaceAfter=2)
    sty_sign       = _mk("BR_Sign",      fontSize=9,  textColor=_C_MID_G, spaceAfter=2)
    sty_sign_name  = _mk("BR_SignName",  fontSize=10, fontName="Helvetica-Bold",
                          textColor=_C_TEXT,  spaceAfter=4)
    sty_sec_hdr    = _mk("BR_SecHdr",    fontSize=7.5, fontName="Helvetica-Bold",
                          textColor=_C_WHITE, spaceAfter=0)
    sty_kv_lbl     = _mk("BR_KVLbl",    fontSize=8,  fontName="Helvetica-Bold",
                          textColor=_C_MID_G)
    sty_kv_val     = _mk("BR_KVVal",    fontSize=9,  textColor=_C_TEXT, leading=13)
    sty_id_name    = _mk("BR_IDName",   fontSize=10, fontName="Helvetica-Bold",
                          textColor=_C_DARK,  spaceBefore=4, spaceAfter=3)
    sty_notes      = _mk("BR_Notes",    fontSize=8.5, textColor=_C_MID_G, leading=13)
    sty_photo_hdr  = _mk("BR_PhotoHdr", fontSize=10, fontName="Helvetica-Bold",
                          textColor=_C_DARK,  spaceBefore=6, spaceAfter=5)
    sty_photo_lbl  = _mk("BR_PhotoLbl", fontSize=7.5, textColor=_C_MID_G, alignment=1)
    sty_tbl_hdr    = _mk("BR_TblHdr",   fontSize=7.5, fontName="Helvetica-Bold",
                          textColor=_C_WHITE, spaceAfter=0)

    W, H  = A4
    lm    = 2 * cm
    rm    = 2 * cm
    bw    = W - lm - rm

    body_frame = Frame(
        lm,
        _FOOTER_H + 0.55 * cm,
        bw,
        H - _HEADER_H - _FOOTER_H - 1.05 * cm,
        leftPadding=0, rightPadding=0,
        topPadding=0.45 * cm, bottomPadding=0,
        id="body",
    )

    def _on_page(canvas: Any, doc: Any) -> None:
        _draw_bulk_report_chrome(canvas, doc, logo_tmp, fields)

    page_tpl = PageTemplate(id="main", frames=[body_frame], onPage=_on_page)
    doc_obj  = BaseDocTemplate(
        pdf_path,
        pagesize=A4,
        pageTemplates=[page_tpl],
        title=f"FBA Claim Evidence \u00b7 {fields['order_id']}",
        author=_COMPANY_NAME,
        leftMargin=lm, rightMargin=rm,
        topMargin=_HEADER_H, bottomMargin=_FOOTER_H + 0.55 * cm,
    )

    def _sec(label: str) -> Table:
        """Dark coloured section-header bar."""
        t = Table([[Paragraph(label, sty_sec_hdr)]], colWidths=[bw])
        t.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, -1), _C_DARK),
            ("TOPPADDING",    (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING",   (0, 0), (-1, -1), 8),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ]))
        return t

    def _kv(rows: list[tuple[str, str]]) -> Table:
        """2-column key-value table with alternating row backgrounds."""
        data = [
            [
                Paragraph(_xml_esc(k), sty_kv_lbl),
                Paragraph(_xml_esc(v), sty_kv_val),
            ]
            for k, v in rows
        ]
        t = Table(data, colWidths=[bw * 0.28, bw * 0.72])
        t.setStyle(TableStyle([
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [_C_WHITE, _C_GREY_L]),
            ("GRID",           (0, 0), (-1, -1), 0.3, _C_GREY_B),
            ("TOPPADDING",     (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING",  (0, 0), (-1, -1), 4),
            ("LEFTPADDING",    (0, 0), (-1, -1), 8),
            ("RIGHTPADDING",   (0, 0), (-1, -1), 8),
            ("VALIGN",         (0, 0), (-1, -1), "TOP"),
        ]))
        return t

    story: list = []

    # ════════════════════════════════════════════════════════════ PAGE 1 ══
    story.append(Paragraph("Claim evidence package", sty_pkg_title))
    story.append(Paragraph("BATCH SELECTION \u00b7 1 line item", sty_pkg_sub))
    story.append(
        Paragraph(
            f"To Amazon Seller Support, please review the evidence "
            f"regarding order <b>{_xml_esc(fields['order_id'])}</b>.",
            sty_intro,
        )
    )
    story.append(Spacer(1, 0.2 * cm))
    story.append(Paragraph("Master summary \u2014 line items", sty_sec_lbl))
    story.append(Spacer(1, 0.1 * cm))

    _col_ws = [bw * 0.27, bw * 0.18, bw * 0.17, bw * 0.16, bw * 0.08, bw * 0.14]
    summary_data = [
        [Paragraph(h, sty_tbl_hdr) for h in
         ["ITEM NAME", "ORDER ID", "DEFECT TYPE", "STATUS", "PHOTO", "DETAIL"]],
        [
            Paragraph(_xml_esc(fields["item_name"]),      sty_body),
            Paragraph(_xml_esc(fields["order_id"]),       sty_body),
            Paragraph(_xml_esc(fields["claim_type"]),     sty_body),
            Paragraph(_xml_esc(fields["status_display"]), sty_body),
            Paragraph("\u2014",                           sty_small),
            Paragraph("p. 2",                             sty_body),
        ],
    ]
    summary_tbl = Table(summary_data, colWidths=_col_ws)
    summary_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0), _C_DARK),
        ("BACKGROUND",    (0, 1), (-1, -1), _C_WHITE),
        ("GRID",          (0, 0), (-1, -1), 0.4, _C_GREY_B),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(summary_tbl)
    story.append(Spacer(1, 0.8 * cm))

    story.append(Paragraph("Respectfully,", sty_sign))
    story.append(Paragraph(_COMPANY_NAME,   sty_sign_name))

    story.append(PageBreak())

    # ════════════════════════════════════════════════════════════ PAGE 2 ══
    story.append(Paragraph("Claim evidence package", sty_pkg_title))
    story.append(
        Paragraph(
            f"Item 1 of 1 \u00b7 {_xml_esc(fields['claim_id'])} "
            f"\u00b7 Issue: {_xml_esc(fields['claim_type'])}",
            sty_pkg_sub,
        )
    )
    story.append(Spacer(1, 0.2 * cm))

    story.append(_sec("IDENTIFIERS"))
    story.append(Paragraph(_xml_esc(fields["item_name"]), sty_id_name))
    story.append(_kv([
        ("ASIN",  f"{fields['asin']} \u00b7 search"),
        ("FNSKU", f"{fields['fnsku']} \u00b7 search"),
        ("SKU",   f"{fields['sku']} \u00b7 search"),
    ]))
    story.append(Spacer(1, 0.3 * cm))

    story.append(_sec("LOGISTICS"))
    story.append(_kv([
        ("Pallet #",  fields["pallet_num"]),
        ("Package #", fields["package_num"]),
        ("Tracking",  fields["tracking"]),
        ("Carrier",   fields["carrier"]),
    ]))
    story.append(Spacer(1, 0.3 * cm))

    story.append(_sec("CLAIM"))
    amt_str = (
        f"{fields['amount']} (filed: {fields['filed_amount']})"
        if fields["amount"] != "\u2014"
        else "\u2014"
    )
    story.append(_kv([
        ("Type",        fields["claim_type"]),
        ("Order ID",    fields["order_id"]),
        ("Amount",      amt_str),
        ("Case ID",     fields["case_id"]),
        ("Link status", fields["link_status"]),
    ]))
    story.append(Spacer(1, 0.3 * cm))

    story.append(_sec("NOTES / COMMENTS"))
    notes_tbl = Table(
        [[Paragraph(_xml_esc(fields["notes"]), sty_notes)]],
        colWidths=[bw],
    )
    notes_tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
        ("BACKGROUND",    (0, 0), (-1, -1), _C_GREY_L),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
    ]))
    story.append(notes_tbl)
    story.append(Spacer(1, 0.3 * cm))

    story.append(Paragraph("Photographic evidence", sty_photo_hdr))
    photo_labels = fields["photo_labels"]
    PHOTO_COLS   = 3
    box_w        = bw / PHOTO_COLS
    box_h        = 2.4 * cm
    photo_rows: list = []
    for i in range(0, len(photo_labels), PHOTO_COLS):
        chunk = photo_labels[i : i + PHOTO_COLS]
        while len(chunk) < PHOTO_COLS:
            chunk.append("")
        photo_rows.append([Paragraph(lbl, sty_photo_lbl) for lbl in chunk])

    if photo_rows:
        photo_tbl = Table(
            photo_rows,
            colWidths=[box_w] * PHOTO_COLS,
            rowHeights=[box_h] * len(photo_rows),
        )
        photo_tbl.setStyle(TableStyle([
            ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
            ("INNERGRID",     (0, 0), (-1, -1), 0.5, _C_GREY_B),
            ("BACKGROUND",    (0, 0), (-1, -1), _C_GREY_L),
            ("VALIGN",        (0, 0), (-1, -1), "BOTTOM"),
            ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
            ("TOPPADDING",    (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 4),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 4),
        ]))
        story.append(photo_tbl)

    try:
        doc_obj.build(story)
    except Exception as exc:
        raise RuntimeError(
            f"[claim-report-service] Bulk-report PDF build failed for {pdf_path!r}: {exc}"
        ) from exc

    if not os.path.isfile(pdf_path):
        raise RuntimeError(
            f"[claim-report-service] Bulk-report PDF missing after build: {pdf_path!r}"
        )

    if logo_tmp and os.path.isfile(logo_tmp):
        try:
            os.remove(logo_tmp)
        except OSError:
            pass

    _log(f"Bulk-report PDF generated at: {pdf_path}")
    return pdf_path
