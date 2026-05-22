-- 20260811120000_pim_identifier_review_queue.sql
--
-- NEXT-18N Migration A (draft): review-queue persistence for identifier disputes.
--
-- Creates: pim_identifier_authority_policy, pim_identifier_dispute,
--          pim_conflict_review_event, pim_canonical_lifecycle_event
--
-- RLS: SELECT only for authenticated (org-scoped). Mutations via service_role / server.
--
-- Explicitly OUT OF SCOPE for this file:
--   - Widening public.products.merge_status CHECK (see TODO comment at end)
--   - Importing NEXT-18M CSV/NDJSON rows
--   - Any writes to products or product_identifier_map
--
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. pim_identifier_authority_policy
--    Per-tenant (and optional per-store) overrides of identifier authority matrix.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pim_identifier_authority_policy (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id                  uuid        REFERENCES public.stores (id) ON DELETE CASCADE,
  kind                      text        NOT NULL
    CHECK (kind IN (
      'asin', 'fnsku', 'sku', 'upc_code', 'mfg_part_number',
      'gtin', 'ean', 'isbn', 'barcode'
    )),
  authority_level           text        NOT NULL
    CHECK (authority_level IN ('strong', 'medium', 'weak')),
  on_conflict_default       text        NOT NULL
    CHECK (on_conflict_default IN (
      'escalate', 'drop_kind_from_winner', 'prefer_most_recently_seen'
    )),
  allow_cross_store_merge   boolean     NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_by                uuid        REFERENCES public.profiles (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.pim_identifier_authority_policy IS
  'Per-organization (and optional per-store) overrides for identifier authority / on-conflict behavior. '
  'NULL store_id means org-wide default for that kind.';

COMMENT ON COLUMN public.pim_identifier_authority_policy.allow_cross_store_merge IS
  'When false (default), merge executor must refuse cross-store merges unless a matching policy row allows it.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pim_id_auth_policy_org_kind_store_null
  ON public.pim_identifier_authority_policy (organization_id, kind)
  WHERE store_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pim_id_auth_policy_org_store_kind
  ON public.pim_identifier_authority_policy (organization_id, store_id, kind)
  WHERE store_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pim_id_auth_policy_organization_id
  ON public.pim_identifier_authority_policy (organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. pim_identifier_dispute
--    One row per classifier dispute / human-review queue item.
--    classifier_fingerprint is the NEXT-18M 32-hex id (NOT a PostgreSQL uuid).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pim_identifier_dispute (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id                  uuid        NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  classifier_fingerprint    text        NOT NULL
    CHECK (classifier_fingerprint ~ '^[0-9a-f]{32}$'),
  shard                     text        NOT NULL
    CHECK (shard IN ('A', 'B')),
  group_id                  text,
  orphan_id                 uuid,
  taxonomy_cell             text        NOT NULL
    CHECK (taxonomy_cell IN ('C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8')),
  secondary_taxonomy_cells  text[]      NOT NULL DEFAULT '{}',
  members                   uuid[]      NOT NULL,
  recommended_winner_id     uuid        REFERENCES public.products (id) ON DELETE SET NULL,
  identifier_conflicts      jsonb       NOT NULL DEFAULT '[]',
  classifier_payload        jsonb       NOT NULL DEFAULT '{}',
  ai_advice                 jsonb,
  hot_loser_flag            boolean     NOT NULL DEFAULT false,
  reversibility_window_h    integer     NOT NULL DEFAULT 72,
  status                    text        NOT NULL
    CHECK (status IN (
      'open', 'claimed', 'decided', 'committed', 'dismissed', 'reverted'
    )),
  detected_at               timestamptz NOT NULL DEFAULT now(),
  detected_by_run_id      text        NOT NULL,
  detected_by_kind          text        NOT NULL
    CHECK (detected_by_kind IN ('operator', 'automation', 'ai_assist', 'pipeline_retry')),
  source_run_id             text,
  policy_version            text,
  ai_advice_shape_version   text,
  claimed_by                uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  claimed_until             timestamptz,
  hot_override_until        timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_pim_identifier_dispute_org_fingerprint
    UNIQUE (organization_id, classifier_fingerprint)
);

COMMENT ON TABLE public.pim_identifier_dispute IS
  'Identifier dispute queue: one row per NEXT-18M-style conflict. '
  'Internal PK is id; classifier_fingerprint is the stable 32-hex fingerprint from offline classifiers.';

COMMENT ON COLUMN public.pim_identifier_dispute.classifier_fingerprint IS
  'Deterministic 32 lowercase hex chars from NEXT-18M (sha256 slice). Not a UUID.';

COMMENT ON COLUMN public.pim_identifier_dispute.members IS
  'Product ids participating in the dispute; validated at insert time by application or import job.';

COMMENT ON COLUMN public.pim_identifier_dispute.classifier_payload IS
  'Classifier output (reasoning, cascade_risks, evidence snapshots, etc.) for audit replay.';

CREATE INDEX IF NOT EXISTS idx_pim_identifier_dispute_org_status_detected
  ON public.pim_identifier_dispute (organization_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_pim_identifier_dispute_org_store_status
  ON public.pim_identifier_dispute (organization_id, store_id, status);

CREATE INDEX IF NOT EXISTS idx_pim_identifier_dispute_shard_a_group
  ON public.pim_identifier_dispute (organization_id, store_id, group_id)
  WHERE shard = 'A' AND group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pim_identifier_dispute_shard_b_orphan
  ON public.pim_identifier_dispute (organization_id, store_id, orphan_id)
  WHERE shard = 'B' AND orphan_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pim_conflict_review_event
--    Append-only review / workflow events for a dispute.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pim_conflict_review_event (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id                uuid        NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  dispute_id              uuid        NOT NULL REFERENCES public.pim_identifier_dispute (id) ON DELETE CASCADE,
  event_type              text        NOT NULL
    CHECK (event_type IN (
      'detected', 'claimed', 'released', 'decision_drafted', 'decision_finalized',
      'committed', 'dismissed', 'reverted', 'expired'
    )),
  actor_id                uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  triggered_by_kind       text        NOT NULL
    CHECK (triggered_by_kind IN ('operator', 'automation', 'ai_assist', 'pipeline_retry')),
  triggered_by_run_id     text,
  reasoning               jsonb       NOT NULL DEFAULT '{}',
  evidence_snapshot       jsonb       NOT NULL DEFAULT '{}',
  inverse_ops             jsonb,
  reversible_until        timestamptz,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  client_ip               inet,
  user_agent              text
);

COMMENT ON TABLE public.pim_conflict_review_event IS
  'Append-only review events for pim_identifier_dispute; source of truth for workflow history.';

CREATE INDEX IF NOT EXISTS idx_pim_conflict_review_event_dispute_occurred
  ON public.pim_conflict_review_event (dispute_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_pim_conflict_review_event_org_occurred
  ON public.pim_conflict_review_event (organization_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. pim_canonical_lifecycle_event
--    Event-sourced log of intended products.merge_status transitions (executor applies later).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pim_canonical_lifecycle_event (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id                  uuid        NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  product_id                uuid        NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  prior_state               text        NOT NULL,
  next_state                text        NOT NULL,
  dispute_id                uuid        REFERENCES public.pim_identifier_dispute (id) ON DELETE SET NULL,
  related_review_event_id   uuid        REFERENCES public.pim_conflict_review_event (id) ON DELETE SET NULL,
  actor_id                  uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  triggered_by_kind         text        NOT NULL
    CHECK (triggered_by_kind IN ('operator', 'automation', 'ai_assist', 'pipeline_retry')),
  triggered_by_run_id       text,
  reasoning                 jsonb       NOT NULL DEFAULT '{}',
  evidence_snapshot         jsonb       NOT NULL DEFAULT '{}',
  inverse_ops               jsonb,
  reversible_until          timestamptz,
  occurred_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pim_canonical_lifecycle_event IS
  'Audit log of intended canonical product lifecycle transitions. '
  'prior_state/next_state must stay compatible with public.products.merge_status CHECK until a future migration widens it.';

CREATE INDEX IF NOT EXISTS idx_pim_canonical_lifecycle_event_product_occurred
  ON public.pim_canonical_lifecycle_event (product_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_pim_canonical_lifecycle_event_org_product
  ON public.pim_canonical_lifecycle_event (organization_id, product_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row level security — authenticated SELECT only (org match)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pim_identifier_authority_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pim_identifier_dispute ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pim_conflict_review_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pim_canonical_lifecycle_event ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pim_identifier_authority_policy'
      AND policyname = 'pim_identifier_authority_policy_org_select'
  ) THEN
    CREATE POLICY pim_identifier_authority_policy_org_select
      ON public.pim_identifier_authority_policy FOR SELECT
      USING (organization_id = public.get_my_organization_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pim_identifier_dispute'
      AND policyname = 'pim_identifier_dispute_org_select'
  ) THEN
    CREATE POLICY pim_identifier_dispute_org_select
      ON public.pim_identifier_dispute FOR SELECT
      USING (organization_id = public.get_my_organization_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pim_conflict_review_event'
      AND policyname = 'pim_conflict_review_event_org_select'
  ) THEN
    CREATE POLICY pim_conflict_review_event_org_select
      ON public.pim_conflict_review_event FOR SELECT
      USING (organization_id = public.get_my_organization_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pim_canonical_lifecycle_event'
      AND policyname = 'pim_canonical_lifecycle_event_org_select'
  ) THEN
    CREATE POLICY pim_canonical_lifecycle_event_org_select
      ON public.pim_canonical_lifecycle_event FOR SELECT
      USING (organization_id = public.get_my_organization_id());
  END IF;
END $$;

-- Authenticated clients: read queue for their org. Writes: service_role (bypasses RLS).
GRANT SELECT ON public.pim_identifier_authority_policy TO authenticated;
GRANT SELECT ON public.pim_identifier_dispute TO authenticated;
GRANT SELECT ON public.pim_conflict_review_event TO authenticated;
GRANT SELECT ON public.pim_canonical_lifecycle_event TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pim_identifier_authority_policy TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pim_identifier_dispute TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pim_conflict_review_event TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pim_canonical_lifecycle_event TO service_role;

COMMIT;

-- TODO (future migration, NOT here): widen public.products.merge_status CHECK constraint to include
--   candidate_duplicate, in_review, reverted_merge per NEXT-18L canonical lifecycle — only after
--   application code and executor are ready to emit those values safely.
