# TRID & claim status — V178

## TRID read path

| Item | Status |
|------|--------|
| TRID V170 / claim read V171 | **PASS** |
| Schema combined smoke V175 | **PASS** |

Filing/submit **gated**.

## Live coverage (staging)

| Table | Resolved | Total | % | Unresolved |
|-------|----------|-------|---|------------|
| `claim_candidates` | 6,581 | 9,055 | **72.7%** | 2,474 |
| `claim_candidate_drafts` | 4,710 | 9,137 | **51.5%** | 4,427 |

**Sources:** V176 close `20260524T140000Z`; V177 `20260524T160000Z`

## UI display (V178 — Neda)

Unresolved and ambiguous rows **must render safely** in claim inbox, drafts, and related surfaces:

| `identifier_resolution_status` | User-facing (V178) |
|--------------------------------|--------------------|
| unresolved (etc.) | **No product link yet** |
| ambiguous | **Needs review** |
| resolved | canonical `product_name` / linkage fields |

Use `ProductLinkageDisplayContract` + `ProductLinkageDisplayBlock` — do not infer product from title/OCR.

**Connector audit:** `product-linkage-ui-data-connector-v178/20260520T150000Z/`

## Resolver milestones

| Prompt | Status |
|--------|--------|
| V175 execute + terminal dry-run | **PASS** / **TERMINAL** (no blind re-execute) |
| V176 draft orphan FK | **PASS_CLOSED** |
| V177 upstream plan | **PASS** read-only — **2,557** dry eligible ≠ approval to execute |

## Known gaps

| Issue | ~Count |
|-------|--------|
| Candidate orphan FK (V175 legacy) | 4,736 |
| `missing_source_row` | 1,543 |
| Identifiers / PIM / ambiguous | see V177 matrix |

Evidence: `claim-upstream-blockers-v177/20260524T160000Z/`

## Forbidden

No claim submit, product auto-create, production writes, blind V175/V176 re-execute.
