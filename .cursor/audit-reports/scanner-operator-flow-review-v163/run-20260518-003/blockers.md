# Blockers

**None** for continued operator-mobile use after stabilization.

This review found UX friction and visibility gaps, not release-blocking defects:

- Save/hydrate paths use `return_items` (per neda-03/06 audits)
- Unknown and unexpected flows have confirmation modals
- Expiry and evidence rules enforce on modal save

## Follow-ups (not blockers)

| Item | Owner suggestion |
|------|------------------|
| Product mismatch on item slip cards | Product / Neda — decide if additive `return_items` select is acceptable |
| Scan queue while busy | Eng — UI-11 if operators report dropped scans |
| Browser spot-check on device | Ops — optional `scanner-neda-09` style pass |
