# Tasks — active board (V183+)

Synced with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md).  
**Canonical base:** V182 rebuild · **Operator slice:** V183 — [HISTORY_POINTERS.md](.ai-memory/HISTORY_POINTERS.md).

## P0 — Policy & Neda env

- [ ] **Verify active quartet → staging** `eiqfaapyumhixxoeltgu` — if not, **top blocker**
- [ ] **Do not** register production; no live AI; no `package_items`; no `.from("returns")`

## P1 — Return-items FBM / matcher (V183 baseline)

- [ ] **UPC/GTIN matcher** (optional charter)
- [ ] **Map enrichment** — V185 showed **0** enrichable; governed only
- [ ] Re-run `return-items-fbm-aware-dry-run-v183` → execute only if `set_resolved_total > 0` + approval  
  (V182 **72/100**, execute **blocked** at V183)

## P2 — Claims / mapping

- [ ] Claim upstream V177 (governed)
- [ ] Next mapping wave / ledger (no blind settlements)

## P3 — Data / roadmap

- [ ] **RETURN-ITEMS-PROD-DATA-CHARTER** — fake/test cohort (~7 rows at V183)
- [ ] NEDA-17 (not run)

## Done — V181 / V182 / V183

- [x] **V182** canonical rebuild — full history on disk
- [x] **V181** expected/inventory Neda read signoff **PASS**
- [x] **V183** FBM dry-run **PASS** (0 `set_resolved`)
- [x] V179 inventory/expected; V178 connector; V176 close; preview signoff
- [x] Claims **72.7%** / **51.5%**; Neda env **ALIGNED** (V183)

## Post-V183 (staging test cohort — separate track)

- [x] V186–V189 closure on staging (see `history-v189/`) — not part of V183 execute gate

## Forbidden

[`.ai-memory/FORBIDDEN_ACTIONS.md`](.ai-memory/FORBIDDEN_ACTIONS.md)
