# Scan speed and focus

## Architecture

Operator scan uses a **hidden laser buffer** (`scannerRef`, `sr-only`) bound to `scanLine` (or `currentPackageTrackingId` during package-scan hidden-carton mode). Enter submits via `onSubmitScan`.

## Focus behavior

`focusScannerAggressive` retries focus at rAF, microtask, 0 ms, 32 ms, and 120 ms. It **skips refocus** when the active element is another `INPUT` / `TEXTAREA` / `SELECT` / contentEditable—preventing carrier and manual fields from feeling “locked.”

`scheduleFocusScanner` runs after modal close, resolve completion, and phase changes unless `modalOpenRef`, `manualOpen`, or laser is disabled.

## Laser enablement (`laserEnabled`)

| Condition | Effect |
|-----------|--------|
| `manualOpen` | Laser off; visible manual fields used |
| `packageScanLaserSuppressed` (active box draft or saved-box search without package card) | Laser off on box step |
| Items phase without receivable box | Laser off |
| Otherwise (identified scan / package / items with box) | Laser on |

## Busy / throughput

```2767:2771:app/scanner/operator-mobile/scan/page.tsx
  /** Keeps laser wedge wedged: items phase stays focusable during save (busy does not disable input). */
  const scannerDisabled =
    manualOpen ||
    !laserEnabled ||
    (busy && flowPhase !== "items");
```

- **Items phase:** wedge stays enabled during save—good for high-volume scanning.
- **Gate / pallet / box:** `scannerDisabled` while `busy`—rapid scans during `runResolve` or identify search can be ignored.
- **`handleItemBarcodeScan`:** early `if (busy) return`—scans during `insertOperatorPackageItemAction` are dropped (modal save path).

## Feedback

- `scanSuccessFlash` on successful unit save (demo + live).
- `playOperatorSuccessBeep` on identify gate match.
- Screen-reader `aria-live`: “Scanner ready” / buffer hint (`sr-only`).

## Friction summary

1. Non-item phases block the wedge during network work—operators may scan twice.
2. Item saves ignore wedge input while `busy` even though input is not disabled—slightly inconsistent.
3. Package-scan laser suppression when a box draft is open forces manual carton field or UI buttons—intentional but easy to miss.

## Assessment

**Adequate for stabilized wedge workflow** with item-phase tuning; gate/box could use a queued-scan buffer (out of scope for UI-only).
