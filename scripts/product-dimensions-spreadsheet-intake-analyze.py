"""Analyze product dimensions xlsx; prints JSON to stdout."""
import json
import re
import sys
from collections import defaultdict

import openpyxl

xlsx = sys.argv[1]
sheet_url = sys.argv[2] if len(sys.argv) > 2 else ""


def norm_header(h):
    if h is None:
        return ""
    return str(h).replace("\r\n", "\n").strip()


def norm_val(v):
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return v


def asin_ok(v):
    if not v:
        return False
    s = str(v).strip().upper()
    return bool(re.match(r"^B0[A-Z0-9]{8}$", s))


def fnsku_ok(v):
    if not v:
        return False
    s = str(v).strip().upper()
    return bool(re.match(r"^X0[A-Z0-9]{8,}$", s))


def parse_dims(s):
    if not s:
        return None
    t = str(s).strip()
    unit = "inch"
    if re.search(r"\bCM\b", t, re.I):
        unit = "unknown"
    nums = []
    parts = re.split(r"\s*[xX×]\s*", t)
    alt = []
    for p in parts:
        m = re.search(r"([\d.]+)", p)
        if m:
            alt.append(float(m.group(1)))
    if len(alt) >= 3:
        nums = alt[:3]
    if len(nums) >= 3:
        return {"l": nums[0], "w": nums[1], "h": nums[2], "unit": unit, "raw": t}
    if len(nums) > 0:
        return {"partial": nums, "unit": unit, "raw": t}
    return {"unit": "unknown", "raw": t}


def weight_unit_from_header(h):
    if re.search(r"\bLB\b", h, re.I):
        return "pound"
    if re.search(r"\bOZ\b", h, re.I):
        return "ounce"
    return "unknown"


wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
sheets = []
all_rows_meta = []

for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        continue
    headers = [norm_header(h) for h in rows[0]]
    data_rows = []
    for i, row in enumerate(rows[1:], start=2):
        if not any(row):
            continue
        rec = {headers[j]: norm_val(row[j]) if j < len(row) else None for j in range(len(headers))}
        rec["_row"] = i
        data_rows.append(rec)
    sheets.append({"name": sheet_name, "headers": headers, "row_count": len(data_rows)})
    all_rows_meta.extend([(sheet_name, r) for r in data_rows])

wb.close()


def classify_col(h):
    hl = h.lower()
    if any(k in hl for k in ["asin", "fnsku", "sku", "upc", "mfg", "gtin", "ean"]):
        return "identifiers"
    if any(k in hl for k in ["dimension", "length", "width", "height", "size", "wt", "weight"]):
        return "dimensions"
    if hl in ("description", "product name", "title") or hl.startswith("description"):
        return "descriptive"
    if any(k in hl for k in ["case pack", "selling pack", "pallet", " ti", " hi"]) or hl in ("ti", "hi"):
        return "packaging"
    if "pack" in hl and "description" not in hl:
        return "packaging"
    if any(k in hl for k in ["brand", "vendor", "category", "manufacturer"]):
        return "vendor_category"
    if any(k in hl for k in ["fba", "fbm", "logistics", "fulfillment"]):
        return "logistics"
    if any(k in hl for k in ["description", "name", "title"]):
        return "descriptive"
    return "other"


headers = sheets[0]["headers"] if sheets else []
col_class = {h: classify_col(h) for h in headers if h}

dim_col = next((h for h in headers if "dimension" in h.lower()), None)
wt_col = next((h for h in headers if "wt" in h.lower() or "weight" in h.lower()), None)
asin_col = next((h for h in headers if "asin" in h.lower()), None)
fnsku_col = next((h for h in headers if "fnsku" in h.lower()), None)
sku_col = next((h for h in headers if "seller-sku" in h.lower() or h.lower() == "sku"), None)

dup_asin = defaultdict(list)
dup_sku = defaultdict(list)
dup_fnsku = defaultdict(list)
missing_id_rows = []
dim_parsed = {"valid": 0, "partial": 0, "missing": 0, "unknown_unit": 0}
unit_counts = {"inch": 0, "pound": 0, "ounce": 0, "unknown": 0}
conflict_asin = []
importable = 0
manual = 0
asin_dims = defaultdict(set)

for sheet_name, rec in all_rows_meta:
    row = rec.get("_row")
    asin = str(rec.get(asin_col) or "").strip().upper() if asin_col else ""
    fnsku = str(rec.get(fnsku_col) or "").strip().upper() if fnsku_col else ""
    sku = str(rec.get(sku_col) or "").strip() if sku_col else ""
    if asin:
        dup_asin[asin].append(row)
    if sku:
        dup_sku[sku].append(row)
    if fnsku:
        dup_fnsku[fnsku].append(row)
    has_id = asin_ok(asin) or bool(sku) or fnsku_ok(fnsku)
    if not has_id:
        missing_id_rows.append(row)
    d_raw = rec.get(dim_col) if dim_col else None
    parsed = parse_dims(d_raw)
    if not parsed or (parsed.get("l") is None and not parsed.get("partial")):
        dim_parsed["missing"] += 1
    elif parsed.get("l") is not None:
        dim_parsed["valid"] += 1
        if parsed.get("unit") == "unknown":
            dim_parsed["unknown_unit"] += 1
        unit_counts[parsed.get("unit", "unknown")] = unit_counts.get(parsed.get("unit", "unknown"), 0) + 1
    else:
        dim_parsed["partial"] += 1
    if wt_col and rec.get(wt_col) is not None:
        u = weight_unit_from_header(wt_col)
        unit_counts[u] = unit_counts.get(u, 0) + 1
    if asin_ok(asin) and parsed and parsed.get("l"):
        key = (round(parsed["l"], 4), round(parsed["w"], 4), round(parsed["h"], 4))
        asin_dims[asin].add(key)
    if asin_ok(asin) and sku and parsed and parsed.get("l"):
        importable += 1
    else:
        manual += 1

dup_asin_multi = {k: v for k, v in dup_asin.items() if len(v) > 1}
dup_sku_multi = {k: v for k, v in dup_sku.items() if len(v) > 1}
dup_fnsku_multi = {k: v for k, v in dup_fnsku.items() if len(v) > 1}

for asin, keys in asin_dims.items():
    if len(keys) > 1:
        conflict_asin.append({"asin": asin, "distinct_dimension_sets": len(keys)})

total = len(all_rows_meta)
summary = {
    "sheet_url": sheet_url,
    "sheet_count": len(sheets),
    "sheet_names": [s["name"] for s in sheets],
    "total_data_rows": total,
    "column_count": len(headers),
    "importable_rows_estimate": importable,
    "manual_review_rows_estimate": manual,
    "duplicate_asin_keys": len(dup_asin_multi),
    "duplicate_sku_keys": len(dup_sku_multi),
    "duplicate_fnsku_keys": len(dup_fnsku_multi),
    "conflicting_asin_dimensions": len(conflict_asin),
    "missing_identifier_rows": len(missing_id_rows),
    "dimensions_valid": dim_parsed["valid"],
    "dimensions_partial": dim_parsed["partial"],
    "dimensions_missing": dim_parsed["missing"],
}

schema_md = f"""# Spreadsheet schema report

**Source:** [Google Sheet]({sheet_url})
**Sheets/tabs:** {len(sheets)} — {", ".join(f"`{s['name']}`" for s in sheets)}

## Per-sheet summary

| Sheet | Data rows | Columns |
|-------|----------:|--------:|
""" + "\n".join(f"| `{s['name']}` | {s['row_count']} | {len(s['headers'])} |" for s in sheets) + """

## Headers (`Sheet1`)

""" + "\n".join(f"- `{h}`" for h in headers) + """

## Notes

- Combined column header uses newline: case + bag dimensions in one field — treat as **case-level** unless split in import rules.
- Weight column header implies **pounds (LB)**; many rows have empty weight values.
"""

id_md = f"""# Identifier quality report

**Total data rows:** {total}

| Check | Count |
|-------|------:|
| Rows with valid ASIN (`B0…`) | {sum(1 for _, r in all_rows_meta if asin_ok(str(r.get(asin_col) or "")))} |
| Rows with seller-sku | {sum(1 for _, r in all_rows_meta if r.get(sku_col))} |
| Rows with FNSKU (`X0…`) | {sum(1 for _, r in all_rows_meta if fnsku_ok(str(r.get(fnsku_col) or "")))} |
| **Missing any identifier** | **{len(missing_id_rows)}** |
| Duplicate ASIN (appears >1 row) | {len(dup_asin_multi)} |
| Duplicate seller-sku | {len(dup_sku_multi)} |
| Duplicate FNSKU | {len(dup_fnsku_multi)} |
| ASIN with conflicting dimension sets | {len(conflict_asin)} |

## Duplicate ASIN sample (first 10)

""" + (
    "\n".join(
        f"- `{k}`: rows {v[:8]}{'…' if len(v) > 8 else ''}" for k, v in list(dup_asin_multi.items())[:10]
    )
    or "None."
) + """

## Missing identifier rows

""" + (f"First 20 row numbers: {missing_id_rows[:20]}" if missing_id_rows else "None.") + """
"""

unit_md = f"""# Dimensions unit report

**Dimension column:** `{dim_col}`
**Weight column:** `{wt_col}` ({weight_unit_from_header(wt_col) if wt_col else "n/a"})

## Parsed dimension strings

| Outcome | Count |
|---------|------:|
| Valid L×W×H (3 numeric) | {dim_parsed["valid"]} |
| Partial / unparseable | {dim_parsed["partial"]} |
| Missing / empty | {dim_parsed["missing"]} |

## Inferred units

| Unit | Row count |
|------|----------:|
| inch (quotes, IN, L/W/H labels) | {unit_counts.get("inch", 0)} |
| pound (weight column populated) | {unit_counts.get("pound", 0)} |
| ounce | {unit_counts.get("ounce", 0)} |
| unknown | {unit_counts.get("unknown", 0) + dim_parsed.get("unknown_unit", 0)} |

## Format patterns observed

- `11" x 5.5 x 7.5"`
- `9.375"L x 5.813"W x 7.313"H`
- `12 IN L x 6.25 IN W x 4.5 IN H`

**Recommendation:** Normalize to **inches** for packaging contract; retain raw string in evidence.
"""

ready_md = f"""# Import readiness report

| Category | Rows | % |
|----------|-----:|--:|
| **Estimated importable** (ASIN + seller-sku + parseable L×W×H) | **{importable}** | {round(100 * importable / max(total, 1), 1)}% |
| **Estimated manual review** | **{manual}** | {round(100 * manual / max(total, 1), 1)}% |

## Blockers to automated import

- {len(dup_asin_multi)} ASINs on multiple rows (variants — need composite packaging key).
- {len(conflict_asin)} ASINs with **different** dimension tuples across rows.
- {len(missing_id_rows)} rows missing identifiers.
- {dim_parsed["missing"]} rows missing dimension text.
- Unit/Case UPC largely sparse — do not use as primary join key.
"""

strat_md = f"""# Recommended import strategy

## Phase 1 — Preflight (read-only)

This audit; no DB writes.

## Phase 2 — Staging match census

1. Join on `seller-sku` + store_id to `products.id`.
2. Cross-check ASIN against `product_identifier_map`.
3. Cohort split: product exists / missing / duplicate ASIN rows.

## Phase 3 — Governed packaging (needs_review)

1. Parse dimensions to inches; tag `SPREADSHEET_INTAKE_<run_id>`.
2. Operator review for {len(conflict_asin)} conflicting ASINs and {len(dup_asin_multi)} duplicate ASIN keys.
3. Do not auto-merge with SP-API volume-only rows without reconciliation.

## Phase 4 — Activation

PC05-style review census → activate in batches.

## Column mapping

| Spreadsheet | Target |
|-------------|--------|
| ASIN (B0) | identifier validation / evidence |
| seller-sku | product join |
| Case Dimensions… | length/width/height (inches) |
| Case Pack / Selling pack ct | units_per_case |
| FBA / FBM | fulfillment_context hint |
| Brand | descriptive evidence only |
"""

print(
    json.dumps(
        {
            "summary": summary,
            "spreadsheet_schema_report_md": schema_md,
            "column_classification": {
                "columns": [{"header": h, "category": col_class.get(h), "index": i} for i, h in enumerate(headers)],
                "by_category": {cat: [h for h, c in col_class.items() if c == cat] for cat in sorted(set(col_class.values()))},
            },
            "identifier_quality_report_md": id_md,
            "dimensions_unit_report_md": unit_md,
            "import_readiness_report_md": ready_md,
            "recommended_import_strategy_md": strat_md,
        }
    )
)
