# Manual filing status entry write V1 — operator approval

**Phase:** PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1

## Approval key (set exactly one line to `yes` or `no`)

APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes

## Scope

- Pilot only: `pilot-20260615T190000Z` / intake `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- Updates: `claim_submissions` row only (status, submission_id, source_payload filing fields)
- Legacy 3 submissions excluded by default

## Hard stops

- No Amazon API calls
- No browser automation
- No file uploads
- No claim_candidates / claim_cases / claim_lines mutation
