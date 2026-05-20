# Neda handoff — V178 (backend + product linkage UI)

**Staging / Preview only.** Production **blocked**.

## You can build against the backend contract now

The server contract is **stable and consumable**:

| Layer | Path | Role |
|-------|------|------|
| **Canonical contract** | `lib/product-linkage-display-contract.ts` | `ProductLinkageDisplayContract` — **use this shape only** |
| Enrichment | `lib/product-linkage-display-enrich.ts` | DB row → contract (server) |
| **Approved server actions** | `app/returns/product-linkage-display-actions.ts` | `fetchProductLinkageDisplayContract`, `buildProductLinkageDisplayContracts` |
| UI copy / labels | `lib/product-linkage-display-ui.ts` | V178 shared strings |
| Unified block | `components/product-linkage/ProductLinkageDisplayBlock.tsx` | Prefer over one-off badges |

**Audit:** `product-linkage-ui-data-connector-v178/20260520T150000Z/`

## Required rules

1. **Always** map/display via `ProductLinkageDisplayContract` fields — not ad-hoc title/SKU guessing.
2. **Only** call **approved server actions** above (or existing returns actions already in repo) for linkage enrichment — **do not** add new browser-side Supabase mutations for product linkage.
3. **Do not direct-write from browser Supabase** (`createBrowserClient` / `supabase.from(...)`) for catalog linkage, resolver columns, or `products` / `product_identifier_map` updates.
4. **Unresolved / ambiguous / mismatch** rows must display **safely**:
   - Unresolved → **“No product link yet”**
   - Ambiguous → **“Needs review”**
   - Headline → `product_name` ?? `fallback_display_name`
   - Use `ProductLinkageDisplayBlock` or existing wired components — never hide bad states or fake “resolved”.
5. **Do not** infer or create products from OCR/title in UI (resolver auto-create forbidden).

## Wired surfaces (V178)

- Claim inbox list / detail
- Claim draft panel
- Manifest lines (`ManifestLineProductLinkage`)
- Return item labels (`ReturnItemProductLinkage`)

## Environment

| Item | Value |
|------|-------|
| DB | `eiqfaapyumhixxoeltgu` |
| Org / store | Sam Distribution Inc · Sam AM |
| Preview signoff | **PASS** (ENV-06C) |

## Data caveats

| Item | Note |
|------|------|
| `return_items` | **6 test rows** on staging — not production KPIs |
| Claim linkage | **72.7%** candidates / **51.5%** drafts — many rows still unresolved; UI must handle them |
| Product mapping | **Partial but operational** — spine 100%; bulk tables partial |

## Status

| Gate | Status |
|------|--------|
| NEDA 15 | **PASS** |
| V178 connector | **PASS** |
| Backend contract consumable | **YES** |
| Production | **Do not use** |

## Do not

- `.from("returns")` — use `return_items`
- `package_items`
- Production deploys or resolver executes
- Live AI / OpenAI (gates default **deny**)
- Browser Supabase writes for linkage/catalog

## Context files

- Day-to-day: `.ai-memory/CURRENT_STATE.md`
- Full timeline: [HISTORY_POINTERS.md](HISTORY_POINTERS.md) → history-v178
