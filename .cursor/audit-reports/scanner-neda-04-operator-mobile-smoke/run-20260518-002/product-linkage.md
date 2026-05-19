# Product linkage (`return_items` / `slip_contents`)

## return_items

| Check | Result |
|-------|--------|
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` (read probe) | **OK** |
| Item-scan list select | Omits linkage columns (by design); enrichment after insert is best-effort (`insertReturn` / patch fallback per neda-01) |
| `manualOverrideReturnItemProductResolution` | Uses `RETURN_SCANNER_LINKAGE_SELECT`; not executed (no write test) |

## slip_contents

| Check | Result |
|-------|--------|
| Full linkage + `notes` select | **42703** on live DB |
| Operator fallback chain | Succeeds at minimal columns (attempt 6); linkage columns not returned until migration |
| `enrichSlipContentsProductLinksAfterReplace` | Still invoked on slip replace paths in `operator-store-actions.ts` |

## expected_packages (identify / EP receive)

Extended scanner product selects **fail** 42703 on linked DB — separate from neda-03 item-scan repair; base `EP_SELECT` used by identify gate **OK**.

## Conclusion

**PASS** for return_items list linkage probe; **degraded** slip linkage display until columns exist — mitigated by select fallbacks, not a regression from package_items repair.
