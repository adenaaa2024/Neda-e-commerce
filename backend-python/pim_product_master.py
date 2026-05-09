"""
Product Master catalog seed helpers: sheet scope, status, category keys, metadata.product_attributes merge.
"""

from __future__ import annotations

import re
from typing import Any

PRODUCT_MASTER_SHEET_NAME = "App_Import_Product_Master"

_PIM_STATUS_ALLOWED = frozenset({"active", "inactive", "draft", "discontinued", "needs_review"})
_PIM_STATUS_ALIASES = {
    "enabled": "active",
    "live": "active",
    "disabled": "inactive",
    "archived": "inactive",
    "": "active",
}

PIM_CORE_LOGICAL_KEYS = frozenset(
    {
        "vendor",
        "category",
        "mfg_part",
        "product_name",
        "seller_sku",
        "asin",
        "fnsku",
        "upc",
        "cost",
        "status",
    }
)

_WS = re.compile(r"\s+")
_SEP_NORM = re.compile(r"\s*&\s*")


def normalize_pim_status(raw: Any) -> str:
    if raw is None:
        return "active"
    s = str(raw).strip().lower()
    if not s:
        return "active"
    s = _PIM_STATUS_ALIASES.get(s, s)
    if s in _PIM_STATUS_ALLOWED:
        return s
    return "needs_review"


def normalize_category_label_for_key(raw: str | None) -> str:
    if not raw:
        return ""
    s = str(raw).strip().lower()
    s = _SEP_NORM.sub(" and ", s)
    s = _WS.sub(" ", s).strip()
    return s


def canonical_category_display_name(raw: str | None) -> str:
    if not raw:
        return ""
    s = str(raw).strip()
    s = _SEP_NORM.sub(" & ", s)
    s = _WS.sub(" ", s).strip()
    return s


def header_to_product_attribute_key(header: str) -> str:
    h = str(header).strip().lower()
    if not h:
        return ""
    h = re.sub(r"[^\w]+", "_", h, flags=re.ASCII)
    h = re.sub(r"_+", "_", h).strip("_")
    return h[:120]


def collect_product_attributes_from_row(
    row_cells: dict[str, Any],
    *,
    mapped_headers: set[str],
    all_headers: list[str],
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for h in all_headers:
        ht = str(h).strip()
        if not ht or ht in mapped_headers:
            continue
        key = header_to_product_attribute_key(ht)
        if not key or key in ("row", "id", "uuid"):
            continue
        val = row_cells.get(ht)
        if val is None:
            continue
        s = str(val).strip()
        if not s or s.lower() in ("n/a", "na", "-", "none", "null", "#n/a"):
            continue
        out[key] = s
    return out


def merge_product_attributes_into_metadata(
    existing_metadata: Any,
    new_attrs: dict[str, Any],
) -> dict[str, Any]:
    base: dict[str, Any] = {}
    if existing_metadata and isinstance(existing_metadata, dict):
        base = dict(existing_metadata)
    prev_attrs: dict[str, Any] = {}
    pa = base.get("product_attributes")
    if isinstance(pa, dict):
        prev_attrs = {str(k): v for k, v in pa.items()}
    merged = {**prev_attrs}
    for k, v in new_attrs.items():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        merged[str(k)] = v.strip() if isinstance(v, str) else v
    base["product_attributes"] = merged
    return base
