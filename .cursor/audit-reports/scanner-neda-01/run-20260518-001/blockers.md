# Blockers

**None for code merge / dev load.**

## Residual (environment)

1. **`identifier_resolution_source` on `return_items`** — missing on DB probed in scanner-neda-02; written best-effort via patch fallback. Re-probe after migration to add to SELECT lists.
2. **EP product linkage columns** — still absent; identify-gate “Product resolution” badges on EP rows only appear when columns exist on loaded rows (today: usually empty; resolution lives on `return_items` / `slip_contents` after receive).
3. **Full `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` from 202607** — not restored until migration applied; use extended constant from migration doc when probed clean.
