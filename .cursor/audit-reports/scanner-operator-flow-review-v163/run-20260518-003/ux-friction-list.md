# UX friction list

Prioritized for operator-mobile scan (`/scanner/operator-mobile/scan`). Severity: **H** high (slows or confuses every session), **M** medium, **L** low.

| # | Severity | Area | Friction |
|---|----------|------|----------|
| F1 | M | Scan speed | Gate/box phases disable wedge while `busy`; rapid scans during resolve/search are dropped with no feedback |
| F2 | M | Scan speed | Item phase: wedge enabled during save but `handleItemBarcodeScan` ignores input while `busy`—inconsistent |
| F3 | M | Hydration | Slip line counts update only after server refetch; no optimistic UI or “syncing” indicator |
| F4 | M | Hydration | Expected Items list can flash “No slip lines yet” during first fetch |
| F5 | H | Mismatch | Product mismatch badges on identify gate only—not on item-phase slip cards where scanning happens |
| F6 | M | Slip visibility | **Awaiting** lines use a 6px dot + screen-reader text only; hard to scan the worklist visually |
| F7 | M | Slip visibility | No indication of FNSKU vs UPC match tier after scan |
| F8 | M | Barcode fallback | Unknown modal: five equal resolve-type buttons; no “try tracking first” guidance |
| F9 | L | Barcode fallback | Scan help popover only on Step 1—not on item phase |
| F10 | M | Barcode fallback | `itemBarcodeMiss` / errors sit mid-column; easy to miss on short viewports |
| F11 | M | Unknown product | “Create unknown box” vs item “Add anyway” both sound like “unknown”—different outcomes |
| F12 | L | Expiry | Perishable heuristic misses short slip descriptions until Expired tag chosen |
| F13 | L | Expiry | Expiry block requires lot + date with no quick-fill |
| F14 | L | Chrome | `ScannerBottomNav` hardcoded `alertCount={2}`—misleading badge |
| F15 | L | Box step | Laser suppressed during active box draft—operators may think scanner is broken |
| F16 | M | Over-scan | Warning appears on list, not inside `ItemUnitRecordModal`—easy to confirm without reading |
| F17 | L | Legacy | `itemDraft` inspection path still in codebase alongside modal—finalize warns if draft open |
| F18 | L | Accessibility | Buffer state only in `sr-only` aria-live—sighted operators rely on visual frame only |

## Non-friction (working well)

- Stale-safe pallet hydrate
- Slip-first matching with ambiguous pickers
- Unexpected item confirmation before save
- Item-phase wedge stays focused during save (input not disabled)
- Identify gate product resolution panel before receive
- Finalize discrepancy copy for qty mismatch
- Deep link from hub search with `?code=`
