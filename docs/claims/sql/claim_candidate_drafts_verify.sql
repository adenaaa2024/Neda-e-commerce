-- =============================================================================
-- claim_candidate_drafts — read-only verification (SELECT only)
-- =============================================================================
-- CLAIM-INBOX-AUDIT-09 — Run after migration 20260814120000_claim_candidate_drafts.sql
-- No writes. Safe in SQL editor with read-only role.
-- =============================================================================

-- 1) Table exists
SELECT to_regclass('public.claim_candidate_drafts') AS table_regclass;

-- 2) Column inventory (expect listed columns)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'claim_candidate_drafts'
ORDER BY ordinal_position;

-- 3) Constraints (CHECK + UNIQUE idempotency)
SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.claim_candidate_drafts'::regclass
ORDER BY conname;

-- 4) Indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'claim_candidate_drafts'
ORDER BY indexname;

-- 5) RLS enabled
SELECT c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'claim_candidate_drafts';

-- 6) Policies (pg_policies view — Postgres 15+)
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'claim_candidate_drafts'
ORDER BY policyname;

-- 7) Row count (expect 0 immediately after migration, before generator load)
SELECT count(*) AS row_count FROM public.claim_candidate_drafts;

-- 8) Idempotency uniqueness sanity (structural — duplicates impossible if UNIQUE enforced)
SELECT idempotency_key, count(*) AS c
FROM public.claim_candidate_drafts
GROUP BY idempotency_key
HAVING count(*) > 1;
