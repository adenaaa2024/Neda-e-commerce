# Undo / audit architecture

**Status:** **APPLIED on staging** (v2 execute PASS)  
**Last updated:** 2026-06-10 (`history-memory-align-after-latest-phase1` `20260610T120000Z`)  
**Migration (repo draft):** `supabase/migrations/20260901120000_delete_cascade_undo_audit_foundation.sql`

## Staging execute — PASS

**DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE PASS**

| Object | Staging |
|--------|---------|
| `undo_snapshots` | **yes** |
| `audit_events` | **yes** |
| `restore_conflicts` | **yes** |
| Preview/apply restore RPCs | **yes** |

**CORRECTED:** Prior census said cascade/undo **draft not applied** — **SUPERSEDED on staging**.

## Original

Apply **pending** — staging proof complete first.

## Integration

Receive integrity: `release_expected_item_unit` / `move_expected_item_unit` (item-level split migrations).

## Next

Wire delete/void server paths to restore RPCs on staging; original apply when approved.
