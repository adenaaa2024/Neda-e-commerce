# Next actions — V183+

See [TASKS.md](../TASKS.md). Primary order from **history-v183** §14.

---

## P0 — Neda environment

| Rule | Status |
|------|--------|
| Active quartet → **`eiqfaapyumhixxoeltgu`** | **ALIGNED** (verify each session) |
| If pointing at original `kxsvedvpjldygtdbylsy` | **STOP** — **top blocker** (ENV-05E) |

---

## Done — V181 / V182 / V183

- [x] **V182** canonical full history on disk
- [x] **V181** expected/inventory Neda read signoff **PASS**
- [x] **V179** inventory + expected_packages read contract
- [x] **V183** FBM dry-run **PASS** (no writes; 0 eligible `set_resolved`)

---

## 1. UPC/GTIN matcher (optional)

`PRODUCT-IDENTIFIER-MATCH-UPC-GTIN-V182` — wire `upc_code` in `lib/product-identifier-match.ts`.

---

## 2. Identifier map enrichment (governed)

V185: **0** enrichable for 5 unresolved rows — dirty/test `source_identifier` + thin map. Governed enrichment only; **no blind** bulk.

---

## 3. Re-run FBM dry-run → conditional execute

```bash
npx tsx scripts/return-items-fbm-aware-dry-run-v183.ts --run-id=<id>
```

- V182: **72/100**, dry-run ready, execute **blocked**
- Execute only if `set_resolved_total > 0` + operator approval

---

## 4. Claim upstream V177 (separate)

Governed waves — no blind execute.

---

## 5. Charters

- **RETURN-ITEMS-PROD-DATA-CHARTER** — replace fake/test cohort (V183 warning)
- **NEDA-17** — not run
- Production — **blocked**

---

## Post-V183 (if resuming later work)

V186–V189 test-cohort closure **done** on staging — see `history-v189/` and `.ai-memory` post-V189 notes in audit packs; no staging resolver re-execute required for that cohort.

---

## Production (blocked)

No production ref, probes, Vercel Production swap, migrations on prod, live AI, Amazon API.
