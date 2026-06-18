# Claim reference materialization execute V1 approval

**Phase:** PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1
**Target:** Original/live `kxsvedvpjldygtdbylsy` only
**Scope:** 10 pilot claim submissions (`pilot-20260615T190000Z` / intake `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`)

## What this approves

Governed materialization / idempotent refresh of deterministic `claim_reference_edges`
for the 10 pilot submissions. Write path is idempotent (`ON CONFLICT DO NOTHING`),
snapshots before/after, and emits a scoped `rollback.sql` (delete by `materialization_run_id`).

## Prerequisites (verified by the executor)

- PHASE-LIVE-REFERENCE-API-COMPLETION-V1 PASS
- PHASE-TRID-REFERENCE-TRACE-MATRIX-V1 PASS (TRID 10/10, 96 edges previewed, 0 ambiguous, 0 missing)
- `claim_reference_edges.candidate_id` schema anchor already applied (PHASE-7H migration)
- No claim_submissions / claim_cases / claim_lines insert or mutation
- No Amazon submission · No scanner change · No invented TRID · VRET is not TRID

## Approval token

Set the token below to `yes` to authorize the production write, then run:

```
npx tsx scripts/phase-claim-reference-materialization-execute-v1.ts --execute
```

APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=yes

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | (Maysam) |
| Date (UTC) | (06/17/2026) |
| Max scope | 10 pilot submissions only |

**Signature:** (pending — flip the token to `yes` to authorize)
