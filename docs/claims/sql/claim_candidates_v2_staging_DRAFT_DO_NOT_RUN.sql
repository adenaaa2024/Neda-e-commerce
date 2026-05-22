-- =============================================================================
-- DRAFT ONLY — DO NOT RUN — PLAN ONLY — REQUIRES PEER REVIEW
-- =============================================================================
-- CLAIM-INBOX-AUDIT-08 — V2 canonical claim candidates staging (design artifact)
--
-- NOT a committed migration. Do not execute in Supabase SQL editor or psql
-- without a separate signed implementation prompt + migration file.
--
-- Purpose: side-by-side staging for generator output before promotion to
--          public.claim_candidates (legacy rows remain untouched).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Optional: enum-like check via TEXT + CHECK (or use CREATE TYPE in real mig)
-- -----------------------------------------------------------------------------

-- CREATE TABLE public.claim_candidate_drafts (
--   id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   organization_id        uuid NOT NULL,
--   store_id               uuid REFERENCES public.stores (id) ON DELETE SET NULL,
--   source_table           text NOT NULL,
--   source_row_id          text NOT NULL,
--   claim_family           text NOT NULL,
--   claim_reason           text NOT NULL,
--   evidence_status        text NOT NULL,
--   confidence_score       numeric NOT NULL,
--   sku                    text,
--   asin                   text,
--   fnsku                  text,
--   product_id             uuid REFERENCES public.products (id) ON DELETE SET NULL,
--   resolved_product_id    uuid REFERENCES public.products (id) ON DELETE SET NULL,
--   generator_version      text NOT NULL,
--   source_run_id          uuid,
--   upload_id              uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
--   idempotency_key        text NOT NULL,
--   generated_by           text NOT NULL,
--   blocker_reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
--   recommended_action     text NOT NULL DEFAULT '',
--   candidate_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
--   lifecycle_status        text NOT NULL DEFAULT 'draft',
--   created_at             timestamptz NOT NULL DEFAULT now(),
--   updated_at             timestamptz NOT NULL DEFAULT now(),
--   promoted_at            timestamptz,
--   archived_at            timestamptz,
--   CONSTRAINT claim_candidate_drafts_lifecycle_status_chk
--     CHECK (lifecycle_status IN (
--       'draft', 'blocked', 'needs_evidence', 'needs_product_link',
--       'ready_for_review', 'approved_for_candidate', 'rejected',
--       'promoted_to_claim_candidates', 'archived'
--     )),
--   CONSTRAINT claim_candidate_drafts_evidence_status_chk
--     CHECK (evidence_status IN ('missing', 'partial', 'complete'))
-- );

-- Dedupe: one logical draft per generator idempotency key.
-- CREATE UNIQUE INDEX uq_claim_candidate_drafts_idempotency_key
--   ON public.claim_candidate_drafts (idempotency_key);

-- Tenant scoping + triage queue.
-- CREATE INDEX idx_claim_candidate_drafts_org_status_created
--   ON public.claim_candidate_drafts (organization_id, lifecycle_status, created_at DESC);

-- Pointer back to operational row (not unique — idempotency_key is canonical).
-- CREATE INDEX idx_claim_candidate_drafts_org_source
--   ON public.claim_candidate_drafts (organization_id, source_table, source_row_id);

-- Partial: ready for human promotion review.
-- CREATE INDEX idx_claim_candidate_drafts_ready_review
--   ON public.claim_candidate_drafts (organization_id, created_at DESC)
--   WHERE lifecycle_status = 'ready_for_review';

-- RLS: mirror other claim tables — service_role + authenticated policies TBD.
-- ALTER TABLE public.claim_candidate_drafts ENABLE ROW LEVEL SECURITY;

-- COMMENT ON TABLE public.claim_candidate_drafts IS
--   'V2 generator staging; promotes to claim_candidates only via explicit workflow.';

-- =============================================================================
-- END DRAFT
-- =============================================================================
