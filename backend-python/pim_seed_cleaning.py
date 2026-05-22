"""PIM catalog seed: trim all cells, split multi-value identifier columns, validate tokens, ambiguity helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any, Literal

import pandas as pd

IdentifierKind = Literal["seller_sku", "asin", "fnsku", "upc"]

_TOKEN_SPLIT_RE = re.compile(r"[,|;\n\r]+")

_EXCEL_ERR = re.compile(
    r"^(#\s*value!\s*|#\s*n/?a\s*|#\s*ref!\s*|#\s*num!\s*|#\s*div/0!\s*)$",
    re.I,
)

# Seller SKU values that look like dates must be rejected.
# Real Seller SKUs are never formatted as calendar dates.
# Catches: MM/DD/YYYY, M/D/YY, MM-DD-YYYY, YYYY-MM-DD, YYYY/MM/DD,
#          DD-Mon (07-Jul), DD-Mon-YYYY (07-Jul-2023),
#          MM-YY short form (07-23 = July '23), Mon-YYYY (Jul-2023)
_DATE_LIKE_SKU_RE = re.compile(
    r"""
    ^(?:
        \d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}   |  # MM/DD/YYYY or MM-DD-YY
        \d{4}[/\-]\d{1,2}[/\-]\d{1,2}      |  # YYYY-MM-DD or YYYY/MM/DD
        \d{1,2}[/\-]                           # DD- or D/
            (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)
            (?:[/\-]\d{2,4})?               |  # DD-Mon or DD-Mon-YYYY
        (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)
            [/\-]\d{2,4}                    |  # Mon-YYYY or Mon-YY
        (?:0?[1-9]|1[0-2])[/\-](?:2[0-9])    # MM-YY like 07-23 (month 1-12, year 20-29)
    )$
    """,
    re.VERBOSE | re.IGNORECASE,
)

_PLACEHOLDER_LOWER = frozenset(
    {
        "",
        "x",
        "n/a",
        "na",
        "-",
        "--",
        "none",
        "null",
        "tbd",
        "pending",
        "unknown",
        "0",
    }
)


def trim_cell_value(val: Any) -> tuple[Any, bool]:
    """
    Trim leading/trailing whitespace for string-like cells.
    Returns (normalized_value, fields_trimmed_increment).
    Empty-after-trim string -> None.
    """
    if val is None:
        return None, False
    try:
        if isinstance(val, float) and pd.isna(val):
            return None, False
    except Exception:
        pass
    if isinstance(val, str):
        raw = val
        t = raw.strip()
        trimmed = bool(raw and t != raw)
        return (t if t else None), trimmed
    if isinstance(val, bool):
        return val, False
    if isinstance(val, (int, float)):
        return val, False
    s = str(val).strip()
    return (s if s else None), False


def trim_row_cells(row_cells: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Return a new dict with every value trimmed; count how many cells had leading/trailing whitespace removed."""
    out: dict[str, Any] = {}
    n = 0
    for k, v in row_cells.items():
        nv, inc = trim_cell_value(v)
        out[k] = nv
        n += int(inc)
    return out, n


def _to_str_for_split(val: Any) -> str:
    if val is None:
        return ""
    try:
        if isinstance(val, float) and pd.isna(val):
            return ""
    except Exception:
        pass
    if isinstance(val, bool):
        return "TRUE" if val else "FALSE"
    if isinstance(val, float):
        m = __import__("math")
        if not m.isfinite(val):
            return ""
        x = round(val)
        if abs(val - x) < 1e-6:
            return str(int(x))
        return str(val).strip()
    if isinstance(val, int) and not isinstance(val, bool):
        return str(val)
    return str(val).strip()


def split_identifier_raw_tokens(raw: Any) -> list[str]:
    s = _to_str_for_split(raw)
    if not s:
        return []
    parts = [p.strip() for p in _TOKEN_SPLIT_RE.split(s)]
    return [p for p in parts if p]


def ordered_unique(tokens: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def is_placeholder_token(t: str) -> bool:
    u = t.strip()
    if not u:
        return True
    if u.lower() in _PLACEHOLDER_LOWER:
        return True
    if _EXCEL_ERR.match(u):
        return True
    if u.lower() == "asin" and len(u) <= 5:
        return True
    return False


_ASIN_RE = re.compile(r"^B0[A-Z0-9]{8}$", re.I)
_FNSKU_X = re.compile(r"^X[A-Z0-9]{9,}$", re.I)
_FNSKU_10 = re.compile(r"^[A-Z0-9]{10}$")


def validate_asin_token(t: str) -> str | None:
    u = t.strip().upper()
    if _ASIN_RE.match(u):
        return u
    return None


def validate_fnsku_token(t: str) -> str | None:
    u = t.strip().upper()
    if _FNSKU_X.match(u):
        return u
    if len(u) == 10 and _FNSKU_10.match(u):
        return u
    return None


def _upc_expand_scientific_text(t: str) -> str:
    """Turn strings like 8.38452E+11 into integer digit strings before stripping non-digits."""
    s = t.strip()
    if not s or "e" not in s.lower():
        return s
    try:
        return str(int(round(float(s))))
    except (ValueError, OverflowError):
        return s


def validate_upc_token(t: str) -> str | None:
    s = _upc_expand_scientific_text(t)
    digits = re.sub(r"\D", "", s)
    if 8 <= len(digits) <= 14 and digits.isdigit():
        return digits
    return None


def validate_seller_sku_token(t: str) -> str | None:
    s = t.strip()
    if not s or is_placeholder_token(s):
        return None
    if len(s) < 1:
        return None
    # Reject values that look like dates — these are never valid Seller SKUs.
    # Patterns: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, YYYY/MM/DD,
    #           DD-Mon (Jul-23), DD-Mon-YYYY, Mon-YYYY, MM-YY (07-23 = July 2023)
    if _DATE_LIKE_SKU_RE.match(s):
        return None
    return s


def validate_token(kind: IdentifierKind, t: str) -> str | None:
    if is_placeholder_token(t):
        return None
    if kind == "asin":
        return validate_asin_token(t)
    if kind == "fnsku":
        return validate_fnsku_token(t)
    if kind == "upc":
        return validate_upc_token(t)
    return validate_seller_sku_token(t)


@dataclass
class ParsedIdentifierColumn:
    original_display: str
    split_tokens: list[str]
    accepted: list[str]
    rejected: list[str]
    duplicate_tokens_collapsed: int
    had_multi_split: bool


@dataclass
class ParsedIdentifierRow:
    seller_sku: ParsedIdentifierColumn
    asin: ParsedIdentifierColumn
    fnsku: ParsedIdentifierColumn
    upc: ParsedIdentifierColumn
    ambiguous: bool = False
    ambiguous_reason: str | None = None
    multi_identifier_cells_split: int = 0
    duplicate_identifier_tokens_collapsed: int = 0
    identifier_tokens_accepted: int = 0
    identifier_tokens_rejected: int = 0

    def primary_sku(self) -> str | None:
        return self.seller_sku.accepted[0] if self.seller_sku.accepted else None

    def primary_fnsku(self) -> str | None:
        return self.fnsku.accepted[0] if self.fnsku.accepted else None

    def primary_asin(self) -> str | None:
        return self.asin.accepted[0] if self.asin.accepted else None

    def primary_upc(self) -> str | None:
        return self.upc.accepted[0] if self.upc.accepted else None


def _parse_one_column(raw: Any, kind: IdentifierKind) -> ParsedIdentifierColumn:
    parts = split_identifier_raw_tokens(raw)
    od = ordered_unique(parts)
    dup_collapsed = max(0, len(parts) - len(od))
    rejected: list[str] = []
    accepted: list[str] = []
    for t in od:
        c = validate_token(kind, t)
        if c is None:
            rejected.append(t)
        else:
            accepted.append(c)
    disp = _to_str_for_split(raw)
    return ParsedIdentifierColumn(
        original_display=disp[:500],
        split_tokens=list(od),
        accepted=accepted,
        rejected=rejected,
        duplicate_tokens_collapsed=dup_collapsed,
        had_multi_split=len(parts) > 1,
    )


def _col(row: dict[str, Any], header: str | None) -> Any:
    if not header:
        return None
    return row.get(header)


def _empty_col() -> ParsedIdentifierColumn:
    return ParsedIdentifierColumn("", [], [], [], 0, False)


def parse_identifier_row(row_cells: dict[str, Any], handles: dict[str, str | None]) -> ParsedIdentifierRow:
    """Parse seller_sku, asin, fnsku, upc columns with split/validate/dedupe."""
    sk = (
        _parse_one_column(_col(row_cells, handles.get("seller_sku")), "seller_sku")
        if handles.get("seller_sku")
        else _empty_col()
    )
    asin = _parse_one_column(_col(row_cells, handles.get("asin")), "asin") if handles.get("asin") else _empty_col()
    fn = _parse_one_column(_col(row_cells, handles.get("fnsku")), "fnsku") if handles.get("fnsku") else _empty_col()
    upc = _parse_one_column(_col(row_cells, handles.get("upc")), "upc") if handles.get("upc") else _empty_col()

    multi = sum(1 for c in (sk, asin, fn, upc) if c.had_multi_split)
    dup = sk.duplicate_tokens_collapsed + asin.duplicate_tokens_collapsed + fn.duplicate_tokens_collapsed + upc.duplicate_tokens_collapsed
    acc_n = len(sk.accepted) + len(asin.accepted) + len(fn.accepted) + len(upc.accepted)
    rej_n = len(sk.rejected) + len(asin.rejected) + len(fn.rejected) + len(upc.rejected)

    amb = False
    reason: str | None = None
    # Multiple seller SKUs in one cell: resolved later via DB (same product vs ambiguous); not ambiguous here.
    if len(fn.accepted) > 1:
        amb, reason = True, "multiple_distinct_fnsku"

    return ParsedIdentifierRow(
        seller_sku=sk,
        asin=asin,
        fnsku=fn,
        upc=upc,
        ambiguous=amb,
        ambiguous_reason=reason,
        multi_identifier_cells_split=multi,
        duplicate_identifier_tokens_collapsed=dup,
        identifier_tokens_accepted=acc_n,
        identifier_tokens_rejected=rej_n,
    )


def finalize_ambiguity_with_db(
    parsed: ParsedIdentifierRow,
    *,
    product_ids_by_asin: dict[str, list[str]],
    product_ids_by_upc: dict[str, list[str]],
) -> ParsedIdentifierRow:
    """Refine ambiguous flag using DB lookups for multi-ASIN / multi-UPC (different existing products)."""
    if parsed.ambiguous:
        return parsed
    asins = parsed.asin.accepted
    if len(asins) > 1:
        pids: set[str] = set()
        for a in asins:
            ids = product_ids_by_asin.get(a) or []
            if len(ids) > 1:
                return replace(parsed, ambiguous=True, ambiguous_reason="asin_resolves_multiple_products")
            for pid in ids:
                pids.add(pid)
        if len(pids) > 1:
            return replace(parsed, ambiguous=True, ambiguous_reason="multiple_asin_map_to_different_products")
    upcs = parsed.upc.accepted
    if len(upcs) > 1:
        pids_u: set[str] = set()
        for u in upcs:
            ids = product_ids_by_upc.get(u) or []
            if len(ids) > 1:
                return replace(parsed, ambiguous=True, ambiguous_reason="upc_resolves_multiple_products")
            for pid in ids:
                pids_u.add(pid)
        if len(pids_u) > 1:
            return replace(parsed, ambiguous=True, ambiguous_reason="multiple_upc_map_to_different_products")
    return parsed


def _pick_broadcast_token(lst: list[str], i: int) -> str | None:
    """Use one list entry per row index; a single-token list is broadcast to every row."""
    if not lst:
        return None
    if len(lst) == 1:
        return lst[0]
    return lst[i] if i < len(lst) else None


def build_identifier_map_variants(parsed: ParsedIdentifierRow, primary_sku_for_map: str | None) -> list[dict[str, str | None]]:
    """
    One product_identifier_map row per index when any identifier column is multi-valued.
    Multiple seller SKUs in one cell: one map row per SKU with ASIN/FNSKU/UPC broadcast.
    """
    ps = primary_sku_for_map or parsed.primary_sku()
    skus = parsed.seller_sku.accepted
    asins = parsed.asin.accepted
    fns = parsed.fnsku.accepted
    upcs = parsed.upc.accepted

    if not (ps or skus or asins or fns or upcs):
        return []

    out: list[dict[str, str | None]] = []
    seen: set[tuple[str | None, str | None, str | None, str | None]] = set()

    if len(skus) > 1:
        n_rows = len(skus)
        for i in range(n_rows):
            sku_v = skus[i]
            a = _pick_broadcast_token(asins, i)
            f = _pick_broadcast_token(fns, i)
            u = _pick_broadcast_token(upcs, i)
            if not (sku_v or a or f or u):
                continue
            key = (sku_v, a, f, u)
            if key in seen:
                continue
            seen.add(key)
            out.append({"seller_sku": sku_v, "asin": a, "fnsku": f, "upc_code": u})
        return out

    n_rows = max(len(asins), len(fns), len(upcs), 1)
    for i in range(n_rows):
        sku_v = ps or _pick_broadcast_token(skus, i)
        a = _pick_broadcast_token(asins, i)
        f = _pick_broadcast_token(fns, i)
        u = _pick_broadcast_token(upcs, i)
        if not (sku_v or a or f or u):
            continue
        key = (sku_v, a, f, u)
        if key in seen:
            continue
        seen.add(key)
        out.append({"seller_sku": sku_v, "asin": a, "fnsku": f, "upc_code": u})
    return out
