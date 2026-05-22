"""Tests for PIM seed import cleaning / identifier splitting."""

from pim_seed_cleaning import (
    ParsedIdentifierColumn,
    ParsedIdentifierRow,
    build_identifier_map_variants,
    parse_identifier_row,
    split_identifier_raw_tokens,
    trim_cell_value,
    validate_asin_token,
    validate_upc_token,
)


def test_trim_asin_cell():
    v, inc = trim_cell_value("  B000ABC123  ")
    assert v == "B000ABC123"
    assert inc is True


def test_asin_duplicate_collapsed():
    raw = "B000ABC123, B000ABC123"
    handles = {"asin": "ASIN"}
    row = {"ASIN": raw}
    p = parse_identifier_row(row, handles)
    assert p.asin.accepted == ["B000ABC123"]
    assert p.asin.duplicate_tokens_collapsed >= 1


def test_asin_value_reject_placeholder():
    raw = "#VALUE!, B000ABC123"
    handles = {"asin": "ASIN"}
    row = {"ASIN": raw}
    p = parse_identifier_row(row, handles)
    assert "#VALUE!" in p.asin.rejected or any("#VALUE" in x for x in p.asin.rejected)
    assert p.asin.accepted == ["B000ABC123"]


def test_upc_two_tokens():
    raw = "012345678905,012345678912"
    handles = {"upc": "UPC"}
    row = {"UPC": raw}
    p = parse_identifier_row(row, handles)
    assert p.upc.accepted == ["012345678905", "012345678912"]


def test_multiple_sku_ambiguous():
    handles = {"seller_sku": "SKU"}
    row = {"SKU": "SKU1, SKU2"}
    p = parse_identifier_row(row, handles)
    assert p.ambiguous is True
    assert p.ambiguous_reason == "multiple_distinct_seller_sku"


def test_split_delimiters():
    assert split_identifier_raw_tokens("a|b;c") == ["a", "b", "c"]


def test_validate_asin_example():
    assert validate_asin_token("B000ABC123") == "B000ABC123"


def _col(accepted: list[str], *, multi: bool = False) -> ParsedIdentifierColumn:
    od = accepted
    return ParsedIdentifierColumn("", od, accepted, [], 0, multi)


def test_build_identifier_map_single_composite_row():
    parsed = ParsedIdentifierRow(
        seller_sku=_col(["B08L421JM6-VEN"]),
        asin=_col(["B08L421JM6"]),
        fnsku=_col(["X004O4ZIFL"]),
        upc=_col(["838452000000"]),
    )
    rows = build_identifier_map_variants(parsed, "B08L421JM6-VEN")
    assert len(rows) == 1
    assert rows[0] == {
        "seller_sku": "B08L421JM6-VEN",
        "asin": "B08L421JM6",
        "fnsku": "X004O4ZIFL",
        "upc_code": "838452000000",
    }


def test_build_identifier_map_broadcasts_second_asin():
    parsed = ParsedIdentifierRow(
        seller_sku=_col(["S1"]),
        asin=_col(["A1", "A2"], multi=True),
        fnsku=_col(["F1"]),
        upc=_col(["12345670"]),
    )
    rows = build_identifier_map_variants(parsed, "S1")
    assert len(rows) == 2
    assert rows[0]["asin"] == "A1" and rows[0]["fnsku"] == "F1" and rows[0]["upc_code"] == "12345670"
    assert rows[1]["asin"] == "A2" and rows[1]["fnsku"] == "F1" and rows[1]["upc_code"] == "12345670"


def test_scientific_notation_upc_string():
    assert validate_upc_token("8.38452E+11") == "838452000000"


def test_float_upc_via_parse():
    handles = {"upc": "UPC"}
    row = {"UPC": 838452000000.0}
    p = parse_identifier_row(row, handles)
    assert p.upc.accepted == ["838452000000"]
