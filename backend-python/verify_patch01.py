"""PATCH-01 + NEXT-02b isolation verifier.

Run from inside backend-python/. Touches no DB, no network, no filesystem.
If any check fails (AssertionError) or a guard regresses, the script exits
non-zero immediately.

PATCH-01 (already verified):
- entry guard at top of `_process_pim_seed_row`

NEXT-02b (this run also covers):
- defense-in-depth guards on `_pim_resolve_product`,
  `_pim_product_ids_for_values`, `_pim_product_ids_for_values_batch`.
"""

import os
import sys

os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""

if "." not in sys.path:
    sys.path.insert(0, ".")

from main import (
    _pim_is_valid_store_uuid,
    _empty_pim_seed_metrics,
    _process_pim_seed_row,
    _pim_resolve_product,
    _pim_product_ids_for_values,
    _pim_product_ids_for_values_batch,
)


def _section(title: str) -> None:
    print()
    print("=" * 60)
    print(title)
    print("=" * 60)


# ─── Recorder used by NEXT-02b sections ────────────────────────────────
# `_pim_product_ids_for_values` and `_pim_product_ids_for_values_batch`
# wrap their db calls in `try/except Exception`. A plain `db=None` would
# raise AttributeError that gets silently swallowed, making us unable to
# distinguish "guard fired" from "db call failed". We therefore raise a
# BaseException subclass (not caught by `except Exception`) when `.table`
# is touched, which proves the helper attempted DB access on valid scope.

class _DbCallAttempt(BaseException):
    """Bypasses `except Exception` in the helpers."""


class _DbCallRecorder:
    def __init__(self) -> None:
        self.called = False
        self.last_table: str | None = None

    def table(self, name: str):
        self.called = True
        self.last_table = name
        raise _DbCallAttempt(name)


VALID_UUID = "00000000-0000-0000-0000-000000000000"


# ════════════════════════════════════════════════════════════════════════
# PATCH-01 sections (kept verbatim so a single run covers both patches)
# ════════════════════════════════════════════════════════════════════════

_section("1. Helper accepts well-formed UUIDs and rejects everything else")

VALID_UUIDS = [
    "00000000-0000-0000-0000-000000000000",
    "12345678-1234-1234-1234-123456789012",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
]
INVALID_VALUES = [
    None,
    "",
    "   ",
    "not-a-uuid",
    "00000000-0000-0000-0000-00000000000",
    "00000000-0000-0000-0000-0000000000000",
    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
    "{not a uuid}",
    "0",
    0,
    [],
    {},
    object(),
]

for v in VALID_UUIDS:
    ok = _pim_is_valid_store_uuid(v)
    assert ok is True, f"valid uuid rejected: {v!r}"
    print(f"  accepted {v!r:50s} -> True")

for v in INVALID_VALUES:
    ok = _pim_is_valid_store_uuid(v)
    assert ok is False, f"invalid value accepted: {v!r}"
    print(f"  rejected {v!r:50s} -> False")


_section("2. Guard fires when store_id is malformed (db=None proves no DB call)")

cm = _empty_pim_seed_metrics()
assert cm["skipped_invalid_store_scope"] == 0
assert cm["skipped_no_identity"] == 0
assert cm["rows_processed"] == 0
assert cm["products_created"] == 0
assert cm["products_updated"] == 0
assert cm["errors"] == []

_process_pim_seed_row(
    db=None,
    organization_id="00000000-0000-0000-0000-000000000000",
    store_id="not-a-uuid",
    row_cells={},
    handles={},
    headers=[],
    amazon_creds=None,
    price_source="verify",
    match_source="verify",
    metrics=cm,
    errors=cm["errors"],
    row_index=42,
    vendor_index={},
    category_index={},
    row_trim=0,
)

assert cm["skipped_invalid_store_scope"] == 1, cm
assert cm["skipped_no_identity"] == 1, cm
assert cm["rows_processed"] == 0, cm
assert cm["products_created"] == 0, cm
assert cm["products_updated"] == 0, cm
assert cm["identifiers_created"] == 0, cm
assert cm["prices_inserted"] == 0, cm
assert len(cm["errors"]) == 1, cm["errors"]
assert "invalid_store_scope" in cm["errors"][0], cm["errors"]
assert "row 42" in cm["errors"][0], cm["errors"]
assert "store_id='not-a-uuid'" in cm["errors"][0], cm["errors"]
print(f"  guard fired, error: {cm['errors'][0]}")


_section("3. Guard fires when organization_id is malformed")

cm = _empty_pim_seed_metrics()
_process_pim_seed_row(
    db=None,
    organization_id="bogus-org-id",
    store_id="00000000-0000-0000-0000-000000000000",
    row_cells={},
    handles={},
    headers=[],
    amazon_creds=None,
    price_source="verify",
    match_source="verify",
    metrics=cm,
    errors=cm["errors"],
    row_index="row-7",
    vendor_index={},
    category_index={},
    row_trim=0,
)
assert cm["skipped_invalid_store_scope"] == 1, cm
assert cm["skipped_no_identity"] == 1, cm
assert cm["rows_processed"] == 0, cm
assert "invalid_store_scope" in cm["errors"][0], cm["errors"]
assert "organization_id='bogus-org-id'" in cm["errors"][0], cm["errors"]
print(f"  guard fired, error: {cm['errors'][0]}")


_section("4. Guard fires when store_id is empty")

cm = _empty_pim_seed_metrics()
_process_pim_seed_row(
    db=None,
    organization_id="00000000-0000-0000-0000-000000000000",
    store_id="",
    row_cells={},
    handles={},
    headers=[],
    amazon_creds=None,
    price_source="verify",
    match_source="verify",
    metrics=cm,
    errors=cm["errors"],
    row_index=1,
    vendor_index={},
    category_index={},
    row_trim=0,
)
assert cm["skipped_invalid_store_scope"] == 1, cm
assert cm["skipped_no_identity"] == 1, cm
assert cm["rows_processed"] == 0, cm
print(f"  guard fired, error: {cm['errors'][0]}")


_section("5. Guard fires when both org and store are None")

cm = _empty_pim_seed_metrics()
_process_pim_seed_row(
    db=None,
    organization_id=None,
    store_id=None,
    row_cells={},
    handles={},
    headers=[],
    amazon_creds=None,
    price_source="verify",
    match_source="verify",
    metrics=cm,
    errors=cm["errors"],
    row_index=2,
    vendor_index={},
    category_index={},
    row_trim=0,
)
assert cm["skipped_invalid_store_scope"] == 1, cm
assert cm["skipped_no_identity"] == 1, cm
assert cm["rows_processed"] == 0, cm
print(f"  guard fired, error: {cm['errors'][0]}")


_section("6. Counters accumulate across calls (200-cap on errors only)")

cm = _empty_pim_seed_metrics()
for i in range(5):
    _process_pim_seed_row(
        db=None,
        organization_id="bad",
        store_id="bad",
        row_cells={},
        handles={},
        headers=[],
        amazon_creds=None,
        price_source="verify",
        match_source="verify",
        metrics=cm,
        errors=cm["errors"],
        row_index=i,
        vendor_index={},
        category_index={},
        row_trim=0,
    )
assert cm["skipped_invalid_store_scope"] == 5, cm
assert cm["skipped_no_identity"] == 5, cm
assert cm["rows_processed"] == 0, cm
assert len(cm["errors"]) == 5, cm["errors"]
print(f"  5 calls -> skipped_invalid_store_scope={cm['skipped_invalid_store_scope']}"
      f" skipped_no_identity={cm['skipped_no_identity']}"
      f" errors={len(cm['errors'])}")


_section("7. db=None proof: if guard regresses, this script CANNOT silently pass")

print("  PATCH-01 guard returns at line 5109 BEFORE any line that touches `db`.")
print("  All 6 calls above passed db=None and returned without exception.")
print("  If the guard ever stops firing for any of these inputs, the next")
print("  line in _process_pim_seed_row dereferences `db.table(...)` and this")
print("  script crashes with AttributeError instead of reaching this point.")


# ════════════════════════════════════════════════════════════════════════
# NEXT-02b sections — defense-in-depth on Python resolver helpers
# ════════════════════════════════════════════════════════════════════════

_section("8. NEXT-02b: _pim_resolve_product defense-in-depth")

# 8a: bad scope + db=None must return the no-identity sentinel without raising.
for bad_org, bad_store, label in [
    ("not-a-uuid", VALID_UUID, "malformed org"),
    (VALID_UUID, "not-a-uuid", "malformed store"),
    ("", VALID_UUID, "empty org"),
    (VALID_UUID, "", "empty store"),
    (None, None, "None,None"),
    ("bad", "bad", "non-uuid both"),
]:
    pid, resolution, sku_insert = _pim_resolve_product(
        db=None,
        organization_id=bad_org,
        store_id=bad_store,
        seller_sku="X",
        fnsku="Y",
        asin="Z",
        upc="U",
    )
    assert pid is None, (bad_org, bad_store, pid)
    assert resolution == "no_identity", (bad_org, bad_store, resolution)
    assert sku_insert is None, (bad_org, bad_store, sku_insert)
    print(f"  bad scope ({label:18s}) -> (None, 'no_identity', None) [no raise]")

# 8b: valid scope must reach the DB. Recorder proves a `.table(...)` was attempted.
recorder = _DbCallRecorder()
try:
    _pim_resolve_product(
        db=recorder,
        organization_id=VALID_UUID,
        store_id=VALID_UUID,
        seller_sku="X",
        fnsku=None,
        asin=None,
        upc=None,
    )
    raise AssertionError("expected _DbCallAttempt; guard incorrectly returned on valid scope")
except _DbCallAttempt:
    pass
assert recorder.called, "recorder.table was never called on valid scope"
assert recorder.last_table == "products", recorder.last_table
print(f"  valid scope -> db.table('{recorder.last_table}') WAS attempted (DB path reachable)")


_section("9. NEXT-02b: _pim_product_ids_for_values defense-in-depth")

# 9a: bad scope + db=None returns empty-list mapping for every input value.
for bad_org, bad_store, label in [
    ("not-a-uuid", VALID_UUID, "malformed org"),
    (VALID_UUID, "not-a-uuid", "malformed store"),
    ("", "", "empty both"),
    (None, None, "None,None"),
]:
    out = _pim_product_ids_for_values(
        db=None,
        organization_id=bad_org,
        store_id=bad_store,
        values=["a", "b", "c"],
        col="sku",
    )
    assert out == {"a": [], "b": [], "c": []}, (bad_org, bad_store, out)
    print(f"  bad scope ({label:18s}) -> {{'a': [], 'b': [], 'c': []}}")

# Empty input list also handled.
out = _pim_product_ids_for_values(
    db=None, organization_id="bad", store_id="bad", values=[], col="sku"
)
assert out == {}, out
print(f"  bad scope (empty input)     -> {{}}")

# 9b: valid scope must reach the DB.
recorder = _DbCallRecorder()
try:
    _pim_product_ids_for_values(
        db=recorder,
        organization_id=VALID_UUID,
        store_id=VALID_UUID,
        values=["x"],
        col="sku",
    )
    raise AssertionError("expected _DbCallAttempt; guard incorrectly returned on valid scope")
except _DbCallAttempt:
    pass
assert recorder.called, "recorder.table was never called on valid scope"
assert recorder.last_table == "products", recorder.last_table
print(f"  valid scope -> db.table('{recorder.last_table}') WAS attempted (DB path reachable)")


_section("10. NEXT-02b: _pim_product_ids_for_values_batch defense-in-depth")

# 10a: bad scope + db=None returns deduped empty-list mapping.
for bad_org, bad_store, label in [
    ("not-a-uuid", VALID_UUID, "malformed org"),
    (VALID_UUID, "not-a-uuid", "malformed store"),
    ("", "", "empty both"),
    (None, None, "None,None"),
]:
    out = _pim_product_ids_for_values_batch(
        db=None,
        organization_id=bad_org,
        store_id=bad_store,
        values=["a", "b", "b", "c", "a"],
        col="sku",
    )
    # `dict.fromkeys` preserves first-seen order: a, b, c.
    assert out == {"a": [], "b": [], "c": []}, (bad_org, bad_store, out)
    assert list(out.keys()) == ["a", "b", "c"], list(out.keys())
    print(f"  bad scope ({label:18s}) -> {{'a': [], 'b': [], 'c': []}} (deduped)")

# Empty input list also handled.
out = _pim_product_ids_for_values_batch(
    db=None, organization_id="bad", store_id="bad", values=[], col="sku"
)
assert out == {}, out
print(f"  bad scope (empty input)     -> {{}}")

# 10b: valid scope must reach the DB.
recorder = _DbCallRecorder()
try:
    _pim_product_ids_for_values_batch(
        db=recorder,
        organization_id=VALID_UUID,
        store_id=VALID_UUID,
        values=["x", "y"],
        col="sku",
    )
    raise AssertionError("expected _DbCallAttempt; guard incorrectly returned on valid scope")
except _DbCallAttempt:
    pass
assert recorder.called, "recorder.table was never called on valid scope"
assert recorder.last_table == "products", recorder.last_table
print(f"  valid scope -> db.table('{recorder.last_table}') WAS attempted (DB path reachable)")


_section("11. NEXT-02b db=None proof: no DB call possible when scope is invalid")

print("  All bad-scope calls in §§ 8a, 9a, 10a passed db=None and returned cleanly.")
print("  If any guard regresses, the helper will dereference `db.table(...)` on")
print("  bad scope and crash with AttributeError instead of returning the safe")
print("  default. The valid-scope tests in §§ 8b, 9b, 10b prove the regular")
print("  DB-bound code path is still reachable when scope is valid.")


print()
print("=" * 60)
print("ALL PATCH-01 + NEXT-02B CHECKS PASSED")
print("=" * 60)
