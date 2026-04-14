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

_LOGO_BUCKET = "logos"
_LOGO_STORAGE_PATH = "logo-amazon.jpeg"

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

def _download_logo_from_supabase(
    organization_id: str = "",
    supabase_client: Any = None,
) -> str | None:
    """
    Download the tenant logo from Supabase Storage, normalise it to a
    ReportLab-safe PNG, and return the local temp-file path.

    Storage location::

        bucket : logos
        path   : {organization_id}/logo.jpeg

    Returns *None* on any failure (never raises).
    """
    logo_path = (
        f"{organization_id}/logo.jpeg"
        if organization_id.strip()
        else _LOGO_STORAGE_PATH
    )
    _log(f"Logo: bucket={_LOGO_BUCKET!r} path={logo_path!r}")

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

    # ── Download raw bytes ────────────────────────────────────────────────
    try:
        raw = client.storage.from_(_LOGO_BUCKET).download(logo_path)
    except Exception as exc:
        _log(f"Logo: Supabase Storage download failed ({_LOGO_BUCKET}/{logo_path}): {exc}")
        return None

    if not raw:
        _log("Logo: Supabase returned empty bytes.")
        return None

    _log(f"Logo: download succeeded — {len(raw)} bytes received.")

    # Write raw bytes to a temp file first
    try:
        fd, raw_tmp = tempfile.mkstemp(suffix=".jpeg", prefix="claim_logo_raw_")
        os.close(fd)
        with open(raw_tmp, "wb") as fh:
            fh.write(raw)
    except Exception as exc:
        _log(f"Logo: failed to write raw temp file: {exc}")
        return None

    raw_size = os.path.getsize(raw_tmp)
    _log(f"Logo: raw temp file → {raw_tmp!r}  size={raw_size} bytes")

    if raw_size == 0:
        _log("Logo: raw temp file is empty — aborting.")
        try:
            os.remove(raw_tmp)
        except OSError:
            pass
        return None

    # ── Normalise to PNG via Pillow so ReportLab can always render it ─────
    try:
        from PIL import Image as _PILImage

        fd2, png_tmp = tempfile.mkstemp(suffix=".png", prefix="claim_logo_")
        os.close(fd2)

        with _PILImage.open(raw_tmp) as im:
            _log(f"Logo: PIL opened — mode={im.mode} size={im.size}")
            # Convert palette / RGBA → RGB so JPEG-derived images save cleanly
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(png_tmp, format="PNG")

        png_size = os.path.getsize(png_tmp)
        _log(f"Logo: normalised PNG → {png_tmp!r}  size={png_size} bytes")

        # Cleanup the raw download; return the normalised PNG
        try:
            os.remove(raw_tmp)
        except OSError:
            pass

        if png_size == 0:
            _log("Logo: normalised PNG is empty — falling back to raw file.")
            return raw_tmp  # last resort

        return png_tmp

    except ImportError:
        _log("Logo: Pillow not installed — using raw JPEG directly.")
        return raw_tmp
    except Exception as exc:
        _log(f"Logo: PIL normalisation failed ({exc}) — using raw JPEG as fallback.")
        return raw_tmp


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

    # ── Logo — left side ─────────────────────────────────────────────────
    logo_w = 2.0 * cm
    logo_h = _HEADER_H - 0.6 * cm
    logo_x = 2 * cm
    logo_y = H - _HEADER_H + (_HEADER_H - logo_h) / 2   # vertically centred

    if logo_path and os.path.isfile(logo_path):
        logo_size = os.path.getsize(logo_path)
        _log(
            f"Logo draw started — path={logo_path!r} "
            f"exists=True size={logo_size} bytes "
            f"pos=({logo_x:.1f},{logo_y:.1f}) dim=({logo_w:.1f}×{logo_h:.1f})"
        )
        if logo_size > 0:
            try:
                canvas.drawImage(
                    logo_path,
                    logo_x, logo_y,
                    width=logo_w, height=logo_h,
                    preserveAspectRatio=True,
                    mask="auto",
                )
                _log("Logo draw success.")
            except Exception as _draw_exc:
                _log(f"Logo draw failed: {_draw_exc}")
                _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)
        else:
            _log("Logo draw skipped — file is empty; using text fallback.")
            _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)
    else:
        _log(
            f"Logo draw skipped — path={logo_path!r} "
            f"exists={os.path.isfile(logo_path) if logo_path else False}; "
            "using text fallback."
        )
        _draw_amazon_text(canvas, logo_x, logo_y + logo_h * 0.35)

    # ── Company name + subtitle — immediately right of logo ───────────────
    text_x = logo_x + logo_w + 0.35 * cm

    canvas.setFillColor(_C_WHITE)
    canvas.setFont("Helvetica-Bold", 13)
    canvas.drawString(text_x, H - 1.35 * cm, _COMPANY_NAME)

    canvas.setFillColor(_rl_colors.HexColor("#bbbbbb"))
    canvas.setFont("Helvetica", 8.5)
    canvas.drawString(text_x, H - 1.95 * cm, _DOC_SUBTITLE)

    # ── Marketplace badge — right side ────────────────────────────────────
    badge_w = 2.4 * cm
    badge_h = 0.38 * cm
    badge_x = W - 2 * cm - badge_w
    badge_y = H - 0.78 * cm
    canvas.setFillColor(_C_AMZN)
    canvas.roundRect(badge_x, badge_y - badge_h, badge_w, badge_h, 2, fill=1, stroke=0)
    canvas.setFillColor(_C_WHITE)
    canvas.setFont("Helvetica-Bold", 6.5)
    canvas.drawCentredString(
        badge_x + badge_w / 2, badge_y - badge_h + 0.07 * cm, "MARKETPLACE"
    )

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


# ===========================================================================
# ── REUSABLE SINGLE-ENTRY PDF SERVICE ──
# ===========================================================================
# All symbols below are either private helpers (_-prefixed) or the one public
# entry point: generate_claim_evidence_pdf().
# ===========================================================================


# ---------------------------------------------------------------------------
# Photo download helper
# ---------------------------------------------------------------------------

def _download_photo_to_temp(url: str) -> str | None:
    """
    Download a photo URL to a local temp file.

    Returns the absolute temp-file path on success, *None* on any failure.
    Never raises.
    """
    if not url or not str(url).strip():
        return None
    url = str(url).strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return None
    try:
        import urllib.request
        suffix = ".jpg"
        for ext in (".png", ".jpeg", ".jpg", ".webp", ".gif"):
            if url.lower().split("?")[0].endswith(ext):
                suffix = ext
                break
        fd, tmp = tempfile.mkstemp(suffix=suffix, prefix="claim_photo_")
        os.close(fd)
        urllib.request.urlretrieve(url, tmp)
        return tmp
    except Exception as exc:
        _log(f"Photo download failed for {url!r}: {exc}")
        return None


# ---------------------------------------------------------------------------
# Photo mapping helpers
# ---------------------------------------------------------------------------

def _pick_item_photos(ret: dict[str, Any]) -> dict[str, str]:
    """
    Extract named photo slots from a ``returns`` row's ``photo_evidence`` field.

    ``photo_evidence`` may be a dict (preferred) or an indexed list.
    Recognised slot names → returned keys:
        "item_defective_photo_url", "expiry_label_photo_url"

    Returns a flat ``{slot: url}`` dict; missing slots are omitted.
    """
    out: dict[str, str] = {}
    evidence = ret.get("photo_evidence") or {}
    if isinstance(evidence, list):
        evidence = {str(i): v for i, v in enumerate(evidence)}
    if not isinstance(evidence, dict):
        return out
    slot_map: dict[str, tuple[str, ...]] = {
        "item_defective_photo_url": ("item_defective", "defective", "item", "defect"),
        "expiry_label_photo_url":   ("expiry_label", "expiry", "expiration"),
    }
    for slot, candidate_keys in slot_map.items():
        for k in candidate_keys:
            v = evidence.get(k)
            if isinstance(v, str) and v.strip():
                out[slot] = v.strip()
                break
    return out


def _pick_package_photos(pkg: dict[str, Any]) -> dict[str, str]:
    """
    Extract named photo slots from a ``packages`` row.

    Sources:
    * ``photo_evidence`` (dict) → outer_box_photo_url, box_label_photo_url
    * ``manifest_photo_url``    → packing_slip_photo_url

    Returns a flat ``{slot: url}`` dict; missing slots are omitted.
    """
    out: dict[str, str] = {}
    evidence = pkg.get("photo_evidence") or {}
    if isinstance(evidence, list):
        evidence = {str(i): v for i, v in enumerate(evidence)}
    if isinstance(evidence, dict):
        slot_map: dict[str, tuple[str, ...]] = {
            "outer_box_photo_url": ("outer_box", "box", "outer", "damaged_box", "closed_box"),
            "box_label_photo_url": ("box_label", "label", "fnsku_label", "barcode"),
        }
        for slot, candidate_keys in slot_map.items():
            for k in candidate_keys:
                v = evidence.get(k)
                if isinstance(v, str) and v.strip():
                    out[slot] = v.strip()
                    break
    manifest = pkg.get("manifest_photo_url") or ""
    if isinstance(manifest, str) and manifest.strip():
        out["packing_slip_photo_url"] = manifest.strip()
    return out


# ---------------------------------------------------------------------------
# DB context loader
# ---------------------------------------------------------------------------

def _load_claim_pdf_context(
    submission_id: str,
    organization_id: str,
) -> dict[str, Any]:
    """
    Load a full ``claim_submissions`` row — including linked ``returns``,
    ``packages``, and ``pallets`` rows — from Supabase.

    Relationship chain:
        claim_submissions.return_id → returns.id
        returns.package_id          → packages.id
        returns.pallet_id           → pallets.id

    Returns the merged raw dict ready for ``_normalize_claim_pdf_context``.
    Raises ``ValueError`` when the submission is not found.
    Raises on genuine Supabase / network errors.
    """
    from claim_repository import ClaimRepository  # local import avoids circular deps

    repo = ClaimRepository(organization_id)

    # Rich query: submission row + returns with all fields needed for the PDF
    try:
        q = (
            repo.supabase.table("claim_submissions")
            .select(
                "*, returns(id, order_id, item_name, asin, fnsku, sku, lpn, "
                "pallet_id, package_id, photo_evidence, notes)"
            )
            .eq("id", submission_id)
        )
        if organization_id:
            q = q.eq("organization_id", organization_id)
        resp = q.limit(1).execute()
        rows = resp.data or []
    except Exception as exc:
        raise RuntimeError(
            f"_load_claim_pdf_context: claim_submissions query failed: {exc}"
        ) from exc

    if not rows:
        raise ValueError(
            f"Submission {submission_id!r} not found for org {organization_id!r}"
        )
    row = rows[0]

    # Normalise embedded returns (PostgREST returns a list or dict)
    ret_embed = row.get("returns")
    if isinstance(ret_embed, list) and ret_embed:
        ret_embed = ret_embed[0]
    if isinstance(ret_embed, dict) and ret_embed:
        row["_full_return"] = ret_embed
        _log(
            f"_load_claim_pdf_context: returns embedded — "
            f"item_name={ret_embed.get('item_name')!r} "
            f"asin={ret_embed.get('asin')!r} "
            f"fnsku={ret_embed.get('fnsku')!r} "
            f"sku={ret_embed.get('sku')!r}"
        )
    else:
        # Fallback: fetch returns row by return_id if embed is absent
        ret_id = (row.get("return_id") or "").strip()
        if ret_id:
            _log(f"_load_claim_pdf_context: returns embed empty — fetching by return_id={ret_id!r}")
            try:
                rr = (
                    repo.supabase.table("returns")
                    .select("id, order_id, item_name, asin, fnsku, sku, lpn, "
                            "pallet_id, package_id, photo_evidence, notes")
                    .eq("id", ret_id)
                    .limit(1)
                    .execute()
                )
                rrows = rr.data or []
                if rrows:
                    row["_full_return"] = rrows[0]
            except Exception as exc:
                _log(f"_load_claim_pdf_context: returns fallback query failed (non-fatal): {exc}")

    full_ret: dict = row.get("_full_return") or {}

    # Load packages row via returns.package_id (NOT submission_id — that column doesn't exist)
    pkg_id = (full_ret.get("package_id") or "").strip()
    if pkg_id:
        try:
            pkg_resp = (
                repo.supabase.table("packages")
                .select("id, package_number, tracking_number, carrier_name, "
                        "photo_evidence, manifest_photo_url")
                .eq("id", pkg_id)
                .limit(1)
                .execute()
            )
            pkgs = pkg_resp.data or []
            if pkgs:
                row["_package"] = pkgs[0]
                _log(
                    f"_load_claim_pdf_context: package loaded — "
                    f"number={pkgs[0].get('package_number')!r} "
                    f"tracking={pkgs[0].get('tracking_number')!r} "
                    f"carrier={pkgs[0].get('carrier_name')!r}"
                )
        except Exception as exc:
            _log(f"_load_claim_pdf_context: packages query failed (non-fatal): {exc}")
    else:
        _log("_load_claim_pdf_context: returns.package_id is empty — skipping packages lookup")

    # Load pallets row via returns.pallet_id
    pallet_id = (full_ret.get("pallet_id") or "").strip()
    if pallet_id:
        try:
            plt_resp = (
                repo.supabase.table("pallets")
                .select("id, pallet_number")
                .eq("id", pallet_id)
                .limit(1)
                .execute()
            )
            plts = plt_resp.data or []
            if plts:
                row["_pallet"] = plts[0]
                _log(
                    f"_load_claim_pdf_context: pallet loaded — "
                    f"number={plts[0].get('pallet_number')!r}"
                )
        except Exception as exc:
            _log(f"_load_claim_pdf_context: pallets query failed (non-fatal): {exc}")
    else:
        _log("_load_claim_pdf_context: returns.pallet_id is empty — skipping pallets lookup")

    return row


# ---------------------------------------------------------------------------
# Context normaliser
# ---------------------------------------------------------------------------

def _normalize_claim_pdf_context(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Normalise any raw claim dict (DB row or caller-supplied dict) into the
    standard PDF context shape.

    Field sources (in priority order):
    * ``_full_return``  — returns row loaded by ``_load_claim_pdf_context``
    * ``raw``           — claim_submissions columns (claim_amount, amazon_case_id, status …)
    * ``source_payload``— JSONB bag of extra fields
    * ``_package``      — packages row (tracking_number, carrier_name, package_number)
    * ``_pallet``       — pallets row  (pallet_number)

    All missing fields default to ``"—"``.
    """
    payload: dict = raw.get("source_payload") or {}
    full_ret: dict = raw.get("_full_return") or {}
    pkg: dict      = raw.get("_package") or {}
    pallet: dict   = raw.get("_pallet") or {}

    def _str(*values: Any, fallback: str = "—") -> str:
        """Return the first non-empty string from *values*, else *fallback*."""
        for v in values:
            if v is None:
                continue
            s = str(v).strip()
            if s and s not in ("None", "null", "0"):
                return s
        return fallback

    # ── Core identifiers ────────────────────────────────────────────────────
    claim_id = _str(raw.get("id"), raw.get("submission_id"), fallback="—")

    order_id = _str(
        full_ret.get("order_id"),
        raw.get("amazon_order_id"), raw.get("order_id"),
        payload.get("amazon_order_id"), payload.get("amazonOrderId"), payload.get("order_id"),
        fallback="—",
    )

    # item_name: returns.item_name is the authoritative source
    item_name = _str(
        full_ret.get("item_name"),
        raw.get("item_name"),
        payload.get("item_name"), payload.get("title"),
        payload.get("product_name"), payload.get("name"),
        fallback="—",
    )

    # ASIN / FNSKU / SKU: live on the returns row
    asin  = _str(full_ret.get("asin"),  raw.get("asin"),  payload.get("asin"),  fallback="—")
    fnsku = _str(full_ret.get("fnsku"), raw.get("fnsku"), payload.get("fnsku"), fallback="—")
    sku   = _str(full_ret.get("sku"),   raw.get("sku"),   payload.get("sku"),   fallback="—")

    # ── Logistics — package / pallet rows are the authoritative source ──────
    #   package_number  → display label for "Package #"
    #   pallet_number   → display label for "Pallet #"
    #   tracking_number → packages.tracking_number
    #   carrier         → packages.carrier_name
    package_display  = _str(
        pkg.get("package_number"),
        payload.get("package_number"), payload.get("package_id"), payload.get("package"),
        fallback="—",
    )
    pallet_display   = _str(
        pallet.get("pallet_number"),
        payload.get("pallet_number"), payload.get("pallet_id"), payload.get("pallet"),
        fallback="—",
    )
    tracking_number  = _str(
        pkg.get("tracking_number"),
        payload.get("tracking"), payload.get("tracking_number"), payload.get("trackingNumber"),
        fallback="—",
    )
    carrier          = _str(
        pkg.get("carrier_name"),
        payload.get("carrier"), payload.get("carrier_name"),
        fallback="—",
    )

    # ── Claim financials — claim_amount is a direct numeric column on claim_submissions ──
    raw_amount = raw.get("claim_amount")
    if raw_amount is not None and str(raw_amount).strip() not in ("", "0", "0.00"):
        claim_amount = f"${raw_amount}"
    else:
        claim_amount = _str(
            payload.get("amount"), payload.get("reimbursement_amount"),
            fallback="—",
        )

    # amazon_case_id is written back to claim_submissions by the agent
    amazon_case_id = _str(
        raw.get("amazon_case_id"), raw.get("case_id"),
        payload.get("amazon_case_id"),
        fallback="—",
    )

    defect_type = _str(
        raw.get("claim_type"), raw.get("defect_type"),
        payload.get("claim_type"), payload.get("defect_type"), payload.get("type"),
        fallback="FBA_CLAIM",
    )

    ctx: dict[str, Any] = {
        "company_name":    raw.get("company_name") or _COMPANY_NAME,
        "marketplace":     raw.get("marketplace") or "amazon",
        "submission_id":   claim_id,
        "claim_id":        claim_id,
        "item_name":       item_name,
        "order_id":        order_id,
        "defect_type":     defect_type,
        "status":          _str(raw.get("status"), fallback="ready_to_send"),
        "asin":            asin,
        "fnsku":           fnsku,
        "sku":             sku,
        "pallet_id":       pallet_display,
        "package_id":      package_display,
        "tracking_number": tracking_number,
        "carrier":         carrier,
        "claim_amount":    claim_amount,
        "amazon_case_id":  amazon_case_id,
        "link_status":     _str(payload.get("link_status"), fallback="—"),
        "notes":           _safe_text(
            full_ret.get("notes") or raw.get("notes") or raw.get("description")
            or payload.get("notes") or payload.get("comments"),
            fallback=(
                "Add operator notes, carrier context, or Seller Central "
                "case references here (optional)."
            ),
        ),
        # Photo URL slots — populated below in priority order
        "outer_box_photo_url":      "",
        "box_label_photo_url":      "",
        "packing_slip_photo_url":   "",
        "item_defective_photo_url": "",
        "expiry_label_photo_url":   "",
        "extra_photo_urls":         [],
    }

    # Log resolved values for the fields that were previously empty
    _log(
        f"_normalize: item_name={ctx['item_name']!r} order_id={ctx['order_id']!r} "
        f"asin={ctx['asin']!r} fnsku={ctx['fnsku']!r} sku={ctx['sku']!r}"
    )
    _log(
        f"_normalize: pallet={ctx['pallet_id']!r} package={ctx['package_id']!r} "
        f"tracking={ctx['tracking_number']!r} carrier={ctx['carrier']!r}"
    )
    _log(
        f"_normalize: claim_amount={ctx['claim_amount']!r} "
        f"amazon_case_id={ctx['amazon_case_id']!r}"
    )

    # Priority 1: direct URL overrides already in raw dict
    for slot in (
        "outer_box_photo_url", "box_label_photo_url", "packing_slip_photo_url",
        "item_defective_photo_url", "expiry_label_photo_url",
    ):
        v = raw.get(slot) or ""
        if isinstance(v, str) and v.strip():
            ctx[slot] = v.strip()

    extra = raw.get("extra_photo_urls") or []
    if isinstance(extra, list):
        ctx["extra_photo_urls"] = [u for u in extra if isinstance(u, str) and u.strip()]

    # Priority 2: returns.photo_evidence → item photos
    if full_ret:
        for slot, url in _pick_item_photos(full_ret).items():
            if not ctx.get(slot):
                ctx[slot] = url

    # Priority 3: packages.photo_evidence + packages.manifest_photo_url
    if pkg:
        for slot, url in _pick_package_photos(pkg).items():
            if not ctx.get(slot):
                ctx[slot] = url

    return ctx


# ---------------------------------------------------------------------------
# PDF renderer (2-page business-report style)
# ---------------------------------------------------------------------------

def _render_claim_evidence_pdf(
    ctx: dict[str, Any],
    organization_id: str = "",
    output_dir: str | None = None,
    supabase_client: Any = None,
) -> str:
    """
    Render the standardised 2-page evidence PDF from a normalised context dict.

    * **Page 1** — Master summary: batch header, intro paragraph, and a
      line-item table (ITEM NAME / ORDER ID / DEFECT TYPE / STATUS / PHOTO /
      DETAIL).
    * **Page 2** — Detail view: IDENTIFIERS, LOGISTICS, CLAIM, NOTES /
      COMMENTS, and Photographic evidence grid (real images when URLs are
      available, placeholder cells otherwise).

    Returns the absolute path of the generated PDF.
    Raises ``RuntimeError`` on build failure.
    """
    out_dir = output_dir or _PDF_OUTPUT_DIR
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError:
        out_dir = tempfile.gettempdir()

    ts       = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_sid = (ctx.get("submission_id") or "unknown")
    for ch in r'<>:"/\\|?*':
        safe_sid = safe_sid.replace(ch, "-")
    filename = f"claim-evidence-{safe_sid}-{ts}.pdf"
    pdf_path = os.path.abspath(os.path.join(out_dir, filename))

    # chrome callback needs a minimal fields dict
    chrome_fields = {"claim_id": ctx["claim_id"], "order_id": ctx["order_id"]}

    logo_tmp: str | None = None
    try:
        logo_tmp = _download_logo_from_supabase(organization_id, supabase_client)
    except Exception as _le:
        _log(f"Logo download error (non-fatal): {_le}")

    # Build ordered photo slot list
    photo_slots: list[tuple[str, str]] = [
        ("Damaged Outer Box",       ctx.get("outer_box_photo_url") or ""),
        ("Box Label",               ctx.get("box_label_photo_url") or ""),
        ("Packing Slip / Manifest", ctx.get("packing_slip_photo_url") or ""),
        ("Defective Item",          ctx.get("item_defective_photo_url") or ""),
        ("Expiry Label",            ctx.get("expiry_label_photo_url") or ""),
    ]
    for idx, url in enumerate((ctx.get("extra_photo_urls") or []), start=1):
        photo_slots.append((f"Photo {len(photo_slots) + idx}", url))

    # Pre-download photos (non-fatal; temp paths cleaned up after build)
    photo_tmp_files: list[str] = []
    resolved_photos: list[tuple[str, str | None]] = []
    for label, url in photo_slots:
        local = _download_photo_to_temp(url) if url else None
        if local:
            photo_tmp_files.append(local)
        resolved_photos.append((label, local))

    # ── Paragraph styles ──────────────────────────────────────────────────
    _ss = getSampleStyleSheet()

    def _mk(name: str, **kw: Any) -> ParagraphStyle:
        return ParagraphStyle(name, parent=_ss["Normal"], **kw)

    sty_pkg_title = _mk("CE_PkgTitle", fontSize=12, fontName="Helvetica-Bold",
                         textColor=_C_DARK, spaceAfter=2, spaceBefore=4)
    sty_pkg_sub   = _mk("CE_PkgSub",   fontSize=8,  textColor=_C_MID_G, spaceAfter=8)
    sty_intro     = _mk("CE_Intro",    fontSize=9.5, textColor=_C_TEXT,
                         spaceAfter=6, leading=14)
    sty_sec_lbl   = _mk("CE_SecLbl",   fontSize=9,  fontName="Helvetica-Bold",
                         textColor=_C_TEXT, spaceAfter=3)
    sty_body      = _mk("CE_Body",     fontSize=9,  textColor=_C_TEXT,
                         spaceAfter=3, leading=13)
    sty_small     = _mk("CE_Small",    fontSize=8,  textColor=_C_MID_G, spaceAfter=2)
    sty_sign      = _mk("CE_Sign",     fontSize=9,  textColor=_C_MID_G, spaceAfter=2)
    sty_sign_name = _mk("CE_SignName", fontSize=10, fontName="Helvetica-Bold",
                         textColor=_C_TEXT, spaceAfter=4)
    sty_id_name   = _mk("CE_IDName",   fontSize=10, fontName="Helvetica-Bold",
                         textColor=_C_DARK, spaceBefore=4, spaceAfter=3)
    sty_notes     = _mk("CE_Notes",    fontSize=8.5, textColor=_C_MID_G, leading=13)
    sty_photo_hdr = _mk("CE_PhotoHdr", fontSize=10, fontName="Helvetica-Bold",
                         textColor=_C_DARK, spaceBefore=6, spaceAfter=5)
    sty_photo_lbl = _mk("CE_PhotoLbl", fontSize=7.5, textColor=_C_MID_G, alignment=1)
    sty_tbl_hdr   = _mk("CE_TblHdr",   fontSize=7.5, fontName="Helvetica-Bold",
                         textColor=_C_WHITE, spaceAfter=0)

    W, H = A4
    lm   = 2 * cm
    rm   = 2 * cm
    bw   = W - lm - rm

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
        _draw_bulk_report_chrome(canvas, doc, logo_tmp, chrome_fields)

    page_tpl = PageTemplate(id="main", frames=[body_frame], onPage=_on_page)
    doc_obj  = BaseDocTemplate(
        pdf_path,
        pagesize=A4,
        pageTemplates=[page_tpl],
        title=f"FBA Claim Evidence \u00b7 {ctx['order_id']}",
        author=ctx.get("company_name") or _COMPANY_NAME,
        leftMargin=lm, rightMargin=rm,
        topMargin=_HEADER_H, bottomMargin=_FOOTER_H + 0.55 * cm,
    )

    # ── Card grid helpers ─────────────────────────────────────────────────
    #  3-column layout: IDENTIFIERS | LOGISTICS | CLAIM
    #  Each card = dark header bar + alternating mini key-value rows + border

    # Each outer column = bw/3.  CELL_PAD applied on L+R means the inner card
    # content area = card_w - 2*CELL_PAD = card_inner.  No overflow possible.
    CELL_PAD   = 0.15 * cm
    card_w     = bw / 3
    card_inner = card_w - 2 * CELL_PAD

    sty_chdr = ParagraphStyle("CE_CrdHdr", parent=_ss["Normal"],
                               fontSize=7.5, fontName="Helvetica-Bold",
                               textColor=_C_WHITE)
    sty_clbl = ParagraphStyle("CE_CrdLbl", parent=_ss["Normal"],
                               fontSize=7.5, fontName="Helvetica-Bold",
                               textColor=_C_MID_G)
    sty_cval = ParagraphStyle("CE_CrdVal", parent=_ss["Normal"],
                               fontSize=8, textColor=_C_TEXT, leading=11)

    def _card(title: str, rows: list[tuple[str, str]]) -> Table:
        """Bordered card: dark title header + alternating-row mini-grid."""
        lk = card_inner * 0.40
        lv = card_inner * 0.60
        kv_data = [
            [Paragraph(_xml_esc(k), sty_clbl), Paragraph(_xml_esc(v), sty_cval)]
            for k, v in rows
        ]
        kv = Table(kv_data, colWidths=[lk, lv])
        kv.setStyle(TableStyle([
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [_C_WHITE, _C_GREY_L]),
            ("GRID",           (0, 0), (-1, -1), 0.25, _C_GREY_B),
            ("TOPPADDING",     (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING",  (0, 0), (-1, -1), 3),
            ("LEFTPADDING",    (0, 0), (-1, -1), 5),
            ("RIGHTPADDING",   (0, 0), (-1, -1), 5),
            ("VALIGN",         (0, 0), (-1, -1), "TOP"),
        ]))
        outer = Table(
            [[Paragraph(title, sty_chdr)], [kv]],
            colWidths=[card_inner],
        )
        outer.setStyle(TableStyle([
            # header row
            ("BACKGROUND",    (0, 0), (0, 0), _C_DARK),
            ("TOPPADDING",    (0, 0), (0, 0), 5),
            ("BOTTOMPADDING", (0, 0), (0, 0), 5),
            ("LEFTPADDING",   (0, 0), (0, 0), 7),
            ("RIGHTPADDING",  (0, 0), (0, 0), 7),
            # kv body row — zero extra padding (kv table handles its own)
            ("TOPPADDING",    (0, 1), (0, 1), 0),
            ("BOTTOMPADDING", (0, 1), (0, 1), 0),
            ("LEFTPADDING",   (0, 1), (0, 1), 0),
            ("RIGHTPADDING",  (0, 1), (0, 1), 0),
            # outer border
            ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
        ]))
        return outer

    status_display = ctx["status"].replace("_", " ").title()
    defect_type    = ctx["defect_type"]
    amount         = ctx["claim_amount"]

    story: list = []

    # ══════════════════════════════════════════════════════════════ PAGE 1 ══
    story.append(Paragraph("Claim evidence package", sty_pkg_title))
    story.append(Paragraph("BATCH SELECTION \u00b7 1 line item", sty_pkg_sub))
    story.append(
        Paragraph(
            f"To Amazon Seller Support, please review the evidence "
            f"regarding order <b>{_xml_esc(ctx['order_id'])}</b>.",
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
            Paragraph(_xml_esc(ctx["item_name"]), sty_body),
            Paragraph(_xml_esc(ctx["order_id"]),  sty_body),
            Paragraph(_xml_esc(defect_type),      sty_body),
            Paragraph(_xml_esc(status_display),   sty_body),
            Paragraph("\u2014",                   sty_small),
            Paragraph("p. 2",                     sty_body),
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
    story.append(Paragraph(ctx.get("company_name") or _COMPANY_NAME, sty_sign_name))
    story.append(PageBreak())

    # ══════════════════════════════════════════════════════════════ PAGE 2 ══
    story.append(Paragraph("Claim evidence package", sty_pkg_title))
    story.append(
        Paragraph(
            f"Item 1 of 1 \u00b7 {_xml_esc(ctx['claim_id'])} "
            f"\u00b7 Issue: {_xml_esc(defect_type)}",
            sty_pkg_sub,
        )
    )
    story.append(Paragraph(_xml_esc(ctx["item_name"]), sty_id_name))
    story.append(Spacer(1, 0.2 * cm))

    # ── 3-column card grid: IDENTIFIERS | LOGISTICS | CLAIM ───────────────
    ids_card = _card("IDENTIFIERS", [
        ("ASIN",  ctx["asin"]),
        ("FNSKU", ctx["fnsku"]),
        ("SKU",   ctx["sku"]),
    ])
    log_card = _card("LOGISTICS", [
        ("Pallet #",  ctx["pallet_id"]),
        ("Package #", ctx["package_id"]),
        ("Tracking",  ctx["tracking_number"]),
        ("Carrier",   ctx["carrier"]),
    ])
    clm_card = _card("CLAIM", [
        ("Type",        defect_type),
        ("Order ID",    ctx["order_id"]),
        ("Amount",      amount),
        ("Case ID",     ctx["amazon_case_id"]),
        ("Link status", ctx["link_status"]),
    ])

    grid_tbl = Table(
        [[ids_card, log_card, clm_card]],
        colWidths=[card_w, card_w, card_w],
        spaceBefore=0,
        spaceAfter=0,
    )
    grid_tbl.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LEFTPADDING",   (0, 0), (-1, -1), CELL_PAD),
        ("RIGHTPADDING",  (0, 0), (-1, -1), CELL_PAD),
    ]))
    story.append(grid_tbl)
    story.append(Spacer(1, 0.3 * cm))

    # ── NOTES / COMMENTS — full-width styled card ─────────────────────────
    sty_notes_hdr = ParagraphStyle("CE_NotesHdr", parent=_ss["Normal"],
                                    fontSize=7.5, fontName="Helvetica-Bold",
                                    textColor=_C_WHITE)
    notes_card = Table(
        [
            [Paragraph("NOTES / COMMENTS", sty_notes_hdr)],
            [Paragraph(_xml_esc(ctx["notes"]), sty_notes)],
        ],
        colWidths=[bw],
    )
    notes_card.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (0, 0), _C_DARK),
        ("TOPPADDING",    (0, 0), (0, 0), 5),
        ("BOTTOMPADDING", (0, 0), (0, 0), 5),
        ("LEFTPADDING",   (0, 0), (0, 0), 8),
        ("RIGHTPADDING",  (0, 0), (0, 0), 8),
        ("BACKGROUND",    (0, 1), (0, 1), _C_GREY_L),
        ("TOPPADDING",    (0, 1), (0, 1), 7),
        ("BOTTOMPADDING", (0, 1), (0, 1), 7),
        ("LEFTPADDING",   (0, 1), (0, 1), 8),
        ("RIGHTPADDING",  (0, 1), (0, 1), 8),
        ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
    ]))
    story.append(notes_card)
    story.append(Spacer(1, 0.3 * cm))

    # ── Photographic evidence — 3-column grid with bordered cells ─────────
    story.append(Paragraph("Photographic evidence", sty_photo_hdr))

    PHOTO_COLS   = 3
    PHOTO_PAD    = 0.15 * cm                        # L+R cell padding
    photo_col_w  = bw / PHOTO_COLS
    photo_inner  = photo_col_w - 2 * PHOTO_PAD      # inner card width — no overflow
    img_h        = 3.2 * cm                          # image area height
    lbl_h        = 0.55 * cm                         # label row height
    cell_h       = img_h + lbl_h

    sty_photo_title = ParagraphStyle("CE_PTitle", parent=_ss["Normal"],
                                      fontSize=7.5, fontName="Helvetica-Bold",
                                      textColor=_C_TEXT, alignment=1)

    def _photo_cell(label: str, local_path: str | None) -> Table:
        """One photo card: bold title row + image/placeholder row."""
        if local_path and os.path.isfile(local_path):
            try:
                from reportlab.platypus import Image as _RLImage
                img_elem: Any = _RLImage(
                    local_path,
                    width=photo_inner - 0.3 * cm,
                    height=img_h - 0.2 * cm,
                )
            except Exception as _ie:
                _log(f"Photo cell image failed for {label!r}: {_ie}")
                img_elem = Paragraph("", sty_photo_lbl)
        else:
            img_elem = Paragraph("", sty_photo_lbl)

        cell = Table(
            [
                [Paragraph(_xml_esc(label) if label else "", sty_photo_title)],
                [img_elem],
            ],
            colWidths=[photo_inner],
            rowHeights=[lbl_h, img_h],
        )
        cell.setStyle(TableStyle([
            # title row
            ("BACKGROUND",    (0, 0), (0, 0), _rl_colors.HexColor("#e8eaf0")),
            ("TOPPADDING",    (0, 0), (0, 0), 3),
            ("BOTTOMPADDING", (0, 0), (0, 0), 3),
            ("LEFTPADDING",   (0, 0), (0, 0), 4),
            ("RIGHTPADDING",  (0, 0), (0, 0), 4),
            # image row
            ("BACKGROUND",    (0, 1), (0, 1), _C_GREY_L),
            ("ALIGN",         (0, 1), (0, 1), "CENTER"),
            ("VALIGN",        (0, 1), (0, 1), "MIDDLE"),
            ("TOPPADDING",    (0, 1), (0, 1), 3),
            ("BOTTOMPADDING", (0, 1), (0, 1), 3),
            ("LEFTPADDING",   (0, 1), (0, 1), 3),
            ("RIGHTPADDING",  (0, 1), (0, 1), 3),
            # outer border
            ("BOX",           (0, 0), (-1, -1), 0.5, _C_GREY_B),
            ("LINEBELOW",     (0, 0), (0, 0), 0.3, _C_GREY_B),
        ]))
        return cell

    photo_rows: list = []
    for i in range(0, len(resolved_photos), PHOTO_COLS):
        chunk = list(resolved_photos[i : i + PHOTO_COLS])
        while len(chunk) < PHOTO_COLS:
            chunk.append(("", None))
        photo_rows.append([_photo_cell(lbl, pth) for lbl, pth in chunk])

    if photo_rows:
        photo_tbl = Table(
            photo_rows,
            colWidths=[photo_col_w] * PHOTO_COLS,
            rowHeights=[cell_h] * len(photo_rows),
        )
        photo_tbl.setStyle(TableStyle([
            ("TOPPADDING",    (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING",   (0, 0), (-1, -1), PHOTO_PAD),
            ("RIGHTPADDING",  (0, 0), (-1, -1), PHOTO_PAD),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(photo_tbl)

    try:
        doc_obj.build(story)
    except Exception as exc:
        raise RuntimeError(
            f"[claim-report-service] Evidence PDF build failed for {pdf_path!r}: {exc}"
        ) from exc

    if not os.path.isfile(pdf_path):
        raise RuntimeError(
            f"[claim-report-service] Evidence PDF missing after build: {pdf_path!r}"
        )

    # Cleanup temporary assets
    if logo_tmp and os.path.isfile(logo_tmp):
        try:
            os.remove(logo_tmp)
        except OSError:
            pass
    for tmp in photo_tmp_files:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass

    _log(f"Evidence PDF rendered \u2192 {pdf_path}")
    return pdf_path


# ---------------------------------------------------------------------------
# Storage uploader
# ---------------------------------------------------------------------------

def _upload_pdf_to_storage(
    pdf_path: str,
    storage_bucket: str,
    organization_id: str,
    submission_id: str,
    supabase_client: Any = None,
) -> dict[str, str | None]:
    """
    Upload *pdf_path* to Supabase Storage.

    Storage path structure::

        {organization_id}/{submission_id}/claim-report-{timestamp}.pdf

    Returns::

        {"storage_path": str | None, "public_url": str | None}

    Never raises — failures are logged and returned as ``None`` values.
    """
    client = supabase_client
    if client is None:
        url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not (url and key):
            _log("Storage upload: missing Supabase credentials — skipping.")
            return {"storage_path": None, "public_url": None}
        try:
            from supabase import create_client as _cc
            client = _cc(url, key)
        except Exception as _e:
            _log(f"Storage upload: could not create Supabase client: {_e}")
            return {"storage_path": None, "public_url": None}

    ts           = int(datetime.datetime.now().timestamp())
    filename     = f"claim-report-{ts}.pdf"
    org_seg      = (organization_id or "unknown").strip()
    sub_seg      = (submission_id   or "unknown").strip()
    storage_path = f"{org_seg}/{sub_seg}/{filename}"

    _log(f"Storage upload: bucket={storage_bucket!r} path={storage_path!r}")
    try:
        with open(pdf_path, "rb") as fh:
            pdf_bytes = fh.read()
        client.storage.from_(storage_bucket).upload(
            storage_path,
            pdf_bytes,
            file_options={"content-type": "application/pdf", "upsert": "true"},
        )
        _log(f"PDF uploaded → {storage_bucket}/{storage_path}")
    except Exception as exc:
        _log(f"Storage upload failed: {exc}")
        return {"storage_path": None, "public_url": None}

    public_url: str | None = None
    try:
        pub = client.storage.from_(storage_bucket).get_public_url(storage_path)
        public_url = pub if isinstance(pub, str) else None
    except Exception as exc:
        _log(f"get_public_url failed (non-fatal): {exc}")

    return {"storage_path": storage_path, "public_url": public_url}


# ===========================================================================
# ── PUBLIC ENTRY POINT ──
# ===========================================================================

def generate_claim_evidence_pdf(
    *,
    organization_id: str,
    submission_id: str | None = None,
    claim_data: dict | None = None,
    upload_to_storage: bool = True,
    storage_bucket: str = "claim-reports",
) -> dict:
    """
    Generate a standardised 2-page Amazon claim evidence PDF.

    This is the **single public entry point** for evidence PDF generation.
    It can be called from any workflow — ``claim_agent``, a FastAPI endpoint,
    a CLI script, or a background job — with no browser-automation dependency.

    Parameters
    ----------
    organization_id:
        Tenant UUID (required for DB lookups and storage paths).
    submission_id:
        ``claim_submissions.id``.  Used to load context from the database
        when *claim_data* is not supplied.
    claim_data:
        Pass a fully-formed dict to skip the DB load (e.g. when the caller
        already has the Supabase row in memory).  Takes priority over
        *submission_id* when both are supplied.
    upload_to_storage:
        When ``True`` (default), upload the generated PDF to Supabase Storage
        in *storage_bucket* and populate ``storage_path`` / ``public_url`` in
        the returned dict.
    storage_bucket:
        Supabase Storage bucket name (default ``"claim-reports"``).

    Returns
    -------
    dict::

        {
            "ok":             bool,
            "local_pdf_path": str | None,   # absolute path on disk
            "storage_path":   str | None,   # e.g. "reports/claim-evidence-…pdf"
            "public_url":     str | None,   # Supabase public URL
            "filename":       str | None,
            "pages":          int | None,   # always 2 on success
            "error":          str | None,   # set only when ok=False
        }

    Example
    -------
    ::

        result = generate_claim_evidence_pdf(
            organization_id=org_id,
            submission_id=submission_id,
            upload_to_storage=True,
        )
        if result["ok"]:
            print(result["public_url"])
    """
    _log(
        f"generate_claim_evidence_pdf — org={organization_id!r} "
        f"submission={submission_id!r} upload={upload_to_storage}"
    )

    _empty: dict = {
        "ok": False,
        "local_pdf_path": None,
        "storage_path": None,
        "public_url": None,
        "filename": None,
        "pages": None,
        "error": None,
    }

    try:
        # Step 1: resolve raw claim data
        if claim_data is not None:
            raw = claim_data
            _log("Using caller-supplied claim_data dict.")
        elif submission_id:
            _log(f"Loading claim context from DB for submission {submission_id!r}…")
            raw = _load_claim_pdf_context(submission_id, organization_id)
        else:
            _empty["error"] = "Either claim_data or submission_id must be provided."
            return _empty

        # Step 2: normalise to standard context shape
        ctx = _normalize_claim_pdf_context(raw)
        _log(f"Context normalised: item={ctx['item_name']!r} order={ctx['order_id']!r}")

        # Step 3: render the 2-page evidence PDF
        effective_sub_id = submission_id or ctx.get("submission_id") or "unknown"
        pdf_path = _render_claim_evidence_pdf(ctx, organization_id=organization_id)
        filename  = os.path.basename(pdf_path)

        result: dict = {
            "ok":             True,
            "local_pdf_path": pdf_path,
            "storage_path":   None,
            "public_url":     None,
            "filename":       filename,
            "pages":          2,
            "error":          None,
        }

        # Step 4: optionally upload to Supabase Storage
        if upload_to_storage:
            _log(f"Uploading to bucket {storage_bucket!r} → {organization_id}/{effective_sub_id}/…")
            upload_result = _upload_pdf_to_storage(
                pdf_path, storage_bucket, organization_id, effective_sub_id
            )
            result["storage_path"] = upload_result.get("storage_path")
            result["public_url"]   = upload_result.get("public_url")

        return result

    except Exception as exc:
        _log(f"generate_claim_evidence_pdf failed: {exc}")
        _empty["error"] = str(exc)
        return _empty
