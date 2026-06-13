# Returns Center — architecture note (planning only)

**Status:** Not implemented. Do not build until approved. **Scanner mobile is out of scope** — Returns Center complements but does not replace `app/scanner/operator-mobile/**`.

## Purpose

Standalone Menorix module for return operations intelligence: volumes, queues, product issues, customer return patterns, and bridges to Claim Center and Product Story — without duplicating scanner receive UX.

## Surfaces

| Surface | Desktop | Mobile |
|---------|---------|--------|
| Return dashboard | KPI command home + trend cards | Compact KPI cards + bottom nav |
| Return queues | Secondary tables inside queue views | Card lists + filter sheet |
| Product issue detection | Issue board + detail drawer | Full-screen detail sheet |
| Customer return analysis | Charts + customer drill-down | Card summaries |
| Return → claim | Read-only eligibility bridge to `claim_candidates` | Card list linking to Claim Center detail |
| Return → product story | Link to PIM product story | Same, mobile sheet |

## Data spine (read paths)

- `return_items` — physical scanned units only
- `expected_packages` — forecast/API expected units
- `claim_candidates` — unified pool (no writes from Returns Center V1)
- `ProductLinkageDisplayContract` — canonical linkage UI

## Settings

- Returns policy JSONB on `organization_settings` — only keys exposed by platform admin
- SLA thresholds, disposition rules, claim-bridge gates

## Module gate

- `returns` / warehouse module entitlement
- Graceful empty state when module disabled

## Relationship to Claim Center

- Returns Center shows **physical return_items** and eligibility
- Claim Center shows **claim_candidates** pool
- Promotion to `claim_cases` remains explicit operator action (future gated phase)

## Relationship to scanner

- Scanner mobile = operational receive/QC capture
- Returns Center = analytical/command layer on top of stored data
- **No shared UI components with scanner mobile**
