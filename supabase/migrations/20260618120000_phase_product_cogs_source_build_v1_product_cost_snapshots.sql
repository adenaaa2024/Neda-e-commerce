-- PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1
-- PROPOSED additive migration — guarded by object-existence check.
-- DO NOT apply without Maysam approval: APPROVED_PRODUCT_COGS_SCHEMA_MIGRATION_V1=yes

DO $$ BEGIN
  IF to_regclass('public.product_cost_snapshots') IS NULL THEN
    CREATE TABLE public.product_cost_snapshots (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
      store_id          UUID REFERENCES public.stores (id) ON DELETE SET NULL,
      product_id        UUID NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
      unit_cost         NUMERIC(14, 4) NOT NULL CHECK (unit_cost > 0),
      currency          TEXT NOT NULL DEFAULT 'USD',
      effective_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_code       TEXT NOT NULL DEFAULT 'manual_override',
      source_note       TEXT,
      approved_by       UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
      approved_at       TIMESTAMPTZ,
      identifier_type   TEXT,
      identifier_value  TEXT,
      import_session_id UUID,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at        TIMESTAMPTZ
    );

    COMMENT ON TABLE public.product_cost_snapshots IS
      'Governed approved unit cost spine — never sale price or settlement net.';

    CREATE INDEX IF NOT EXISTS idx_product_cost_snapshots_org_product_effective
      ON public.product_cost_snapshots (organization_id, product_id, effective_at DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_product_cost_snapshots_org_store
      ON public.product_cost_snapshots (organization_id, store_id)
      WHERE deleted_at IS NULL;

    ALTER TABLE public.product_cost_snapshots ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
