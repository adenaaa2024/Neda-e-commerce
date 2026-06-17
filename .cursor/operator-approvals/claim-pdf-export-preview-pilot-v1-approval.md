# Claim PDF export preview pilot V1 approval

**Phase:** PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1 (local artifacts only)  
**Contract:** `lib/claims/filing/claim-pdf-export-preview-contract-v1.ts`  
**Prerequisites:**
- `SAFE_TO_BUILD_PDF_EXPORT_PREVIEW=yes` — contract `20260616T080000Z`
- Trusted 10 open pilot cases (6 shipment + 4 order)
- Filing packet preview ready 10/10

APPROVED_CLAIM_PDF_EXPORT_PREVIEW_PILOT_V1=yes

## Scope

Local draft export only under:

`.cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1/{RUN_ID}/`

Per case: HTML preview, JSON export, text summary; PDF draft via local Playwright if available.

**Environment:** original `kxsvedvpjldygtdbylsy` read-only compose only  
**Pilot run:** `pilot-20260615T190000Z`  
**Intake run:** `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`

## Explicitly out of scope

- DB writes (`claim_cases`, `claim_lines`, `claim_candidates`, `claim_submissions`)
- Supabase Storage / permanent upload
- Amazon SP-API submission
- Final filing PDF for portal upload
- AI/GPT narrative generation
- scanner / Product Core resolver / RBAC changes

## Safety

All artifacts carry: DRAFT ONLY · NOT SUBMITTED TO AMAZON · INTERNAL REVIEW PACKET

## Rollback

Delete local audit folder — no DB rollback required.

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-16 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Original store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Max cases | 10 open pilot only |

**Signature:** Maysam — APPROVED_CLAIM_PDF_EXPORT_PREVIEW_PILOT_V1=yes

**Decision:** [x] APPROVED  [ ] DEFER
