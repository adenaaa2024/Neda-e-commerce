# Current state — V183+ (authoritative)

**Last updated:** 2026-05-24 (`ai-memory-update-after-v183` `20260524T180000Z`)  
**Operator history (V183):** [HISTORY_POINTERS.md](HISTORY_POINTERS.md) →  
`.cursor/audit-reports/history-v183/20260520T230000Z/ERP_PIM_FULL_HISTORY_V183_APPEND_ONLY_NEDA_ENV_FBM_DRY_RUN_STATUS.md`  
**Canonical full base:**  
`.cursor/audit-reports/history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md`  
**Cold start:** `history-canonical-rebuild-v182/20260518T120000Z/NEXT_CHAT_BOOTSTRAP.md`

## V181 / V182 / V183 gates (mandatory baseline)

| Gate | Status |
|------|--------|
| **V182 canonical rebuild** | **PASS** — latest **full** append-only base |
| **V181 expected/inventory Neda read signoff** | **PASS** (`20260521T120000Z`) |
| **Neda env → staging** | **`eiqfaapyumhixxoeltgu`** — **ALIGNED**; **P0 top blocker** if active quartet drifts |
| **Return-items FBM V182 audit** | **72/100** — dry-run **ready**; **execute blocked** |
| **Return-items FBM V183 dry-run** | **PASS** — **0** `set_resolved`; execute **blocked** |
| **UPC/GTIN matcher** | **GAP** — tier 4 disabled |
| **`return_items` (V183 cohort)** | **~7** active — **fake/test** warning; **5** unresolved at dry-run |
| **`package_items`** | **FORBIDDEN** / absent |
| **Production** | **NOT_CREATED_YET** / **BLOCKED** |
| Vercel Production DB | `kxsvedvpjldygtdbylsy` — **untouched** |

### V183 dry-run evidence (latest on disk)

`return-items-fbm-aware-dry-run-v183/20260521T140000Z/` — 7 active, 0 new resolves, 5 remain unresolved, tier 4 disabled.

### V185 map enrichment (post-V183)

`return-items-identifier-map-enrichment-v185/20260521T160000Z/` — **0** enrichable; **5** non-enrichable (dirty/test identifiers).

## Carried (unchanged)

| Item | Status |
|------|--------|
| V179 expected_packages + inventory views | **PASS** |
| NEDA V178 connector | **PASS** |
| Claim V176 close | **PASS_CLOSED** |
| Claims | **72.7%** / **51.5%** |
| Legacy `returns` | **FORBIDDEN** — use `return_items` |
| AI gates | Default deny |

## Post-V183 on staging (do not confuse with V183 dry-run)

Later charters **V186–V189** closed the **test cohort** (4 soft-deleted, 3 active resolved, 0 unresolved). See `history-v189/20260524T140000Z/` if you need **current** staging row counts — not the V183 **7-row / 5-unresolved** snapshot.

## Evidence

| Topic | Path |
|-------|------|
| V182 canonical | `history-canonical-rebuild-v182/20260518T120000Z/` |
| V183 | `history-v183/20260520T230000Z/` |
| V181 signoff | `expected-inventory-neda-read-model-signoff-v181/20260521T120000Z/` |
| FBM V183 dry-run | `return-items-fbm-aware-dry-run-v183/20260521T140000Z/` |
| Memory sync | `ai-memory-update-after-v183/20260524T180000Z/` |
