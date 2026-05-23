# Barcode fallback UX

## 1. Scan instructions (Step 1)

Info button toggles `scanBarcodeHelpOpen` popover:

- Explains pallet / tracking / carton / slip / item codes
- Points to **Direct Box Scan** when no pallet
- Context-aware copy when tracking already locked

## 2. Manual entry

- Gate: dedicated manual tracking field (`identifyGate` phase)
- Step 1 scan: `scan-manual` input when not using wedge-only flow
- Box intake: `box-intake-manual` for carton tracking when laser suppressed

`manualOpen` disables laser—operators must choose manual mode explicitly or use visible fields.

## 3. Unrecognized code (`unknownModal`)

After `resolveOperatorBarcode` returns `kind === "unknown"`:

- Grid: force resolve as Tracking / Box / Slip / Pallet / Item (`forceResolve(only)`)
- Optional **Create unknown box** when `allowOperatorUnknownPackageCreate()` (env `NEXT_PUBLIC_OPERATOR_ALLOW_UNKNOWN_PACKAGE_CREATE !== "false"`)
- Store gating: button disabled until `sessionStoreId` resolved

## 4. Item-phase fallbacks

| Situation | UX |
|-----------|-----|
| Barcode matches multiple slip lines | `slipLineCandidatePicker` modal — “Pick slip line” |
| Barcode matches multiple EP rows (no slip) | `candidatePicker` modal — “Pick expected line” |
| Slip exists, barcode not on slip | `unexpectedPackageItemModal` — confirm “Add anyway” |
| No slip UPC/FNSKU and no EP rows | Inline `itemBarcodeMiss` error |
| Operator-initiated | **Add / Scan Item** opens modal with empty barcode |

## 5. Deep link

`?code=` / `?q=` query param auto-runs `runIdentificationGateSearch` then strips param—supports hub search overlay → scan route.

## Friction

1. Unknown modal offers five equal-weight type buttons—no hint which type failed last time.
2. `itemBarcodeMiss` is easy to miss below the fold on small screens (above slip list but below stats).
3. Help popover is Step-1 only—not repeated on item phase where unexpected scans are common.

## Assessment

**Fallback coverage is strong**; polish is mostly hierarchy, phase-aware help, and post-scan error placement.
