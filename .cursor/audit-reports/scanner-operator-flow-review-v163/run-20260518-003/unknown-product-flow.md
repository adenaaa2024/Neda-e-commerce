# Unknown-product flow

## A. Unknown barcode at resolve (shipment / entity level)

Flow: scan → `runResolve` → `r.kind === "unknown"` → `unknownModal`

Options:

1. **Typed resolve** — retry as tracking, package, slip, pallet, or item only
2. **Create unknown box** — `handleCreateUnknownPackage`:
   - Sets `activeBoxSession` with `packageId: null`, tracking = scanned code
   - Jumps to `package_scan` without DB insert in this handler (persist on box save path)
3. **Cancel** — `closeUnknown`, refocus wedge

Env: `allowOperatorUnknownPackageCreate()` default true unless `NEXT_PUBLIC_OPERATOR_ALLOW_UNKNOWN_PACKAGE_CREATE=false`.

## B. Unknown item on box (catalog / slip level)

When slip lines exist but barcode does not match:

→ `unexpectedPackageItemModal` → **Add anyway** → `ItemUnitRecordModal` with `matchKindPreset: "unexpected"` and subtitle explaining no slip link.

Saved via `insertOperatorPackageItemAction` with `slipContentId: null` → counts toward `unexpectedUnits` aggregate row **“Not on packing slip”**.

## C. No slip and no expected-package match

`itemBarcodeMiss` inline message—does not open modal.

## D. Identify gate “new” / manual_new

Inventory visual `manual_new` triggers create-and-start path (separate from unknown modal)—for tracking not in worklist.

## Gaps vs desktop returns review

Operator-mobile **does not** expose full manual product override picker from returns drawer—mismatch is informational at gate only. Back-office review remains out of band (by policy).

## Assessment

Unknown **shipment** and **unit** paths are distinct and well-labeled. Operators may not understand difference between “Create unknown box” and “Add anyway” on item step without training.
