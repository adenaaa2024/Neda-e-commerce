# Cutover risk report

## High

1. **Deploy scanner code before Wave A migrations** — RPCs missing → receive 500.
2. **Bulk map/product clone** — ~4k map delta must use governed scripts.
3. **Grouped rebuild without tracking normalization** — allocation_group_key null / wrong grain.

## Medium

1. **View drift** — carrier normalization changes v_inventory_item_status grain.
2. **Resolver execute before rebuild_valid** — learned from staging allocation fix.

## Low

1. Packaging spreadsheet parity — both refs at 571 profiles per prior verify.
2. EP resolver columns — already applied on original (prior Wave A execute).
