# Next-step recommendation

## Immediate (unblock SCANNER-02B)

1. **Name the target** — Confirm which Supabase project is **staging** or **dev** (not production).
2. **Apply migration** on that project only (Dashboard SQL editor, or Supabase CLI against linked staging).
3. **Re-run verification** — Execute the queries in `schema-verification.md` and optionally log results into a new `scanner-02b` run folder.

## Product workstream

After migration is live on staging, proceed with extended reads and operator UI.

## Exact next prompt (copy)

```text
NEXT-SCANNER-03 — WIRE EXTENDED SELECTS + REVIEW UI + MANUAL OVERRIDE ACTION
```
