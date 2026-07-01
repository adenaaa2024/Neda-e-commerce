-- =============================================================================
-- PHASE-POSITION-HIERARCHY-H1 — Position hierarchy foundation (additive)
-- Adds parent_position_id + sort_order to public.positions with cycle-safe validation.
-- Staging apply only via governed workflow. Do not touch production.
-- =============================================================================

BEGIN;

-- ── 1) Columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS parent_position_id uuid NULL,
  ADD COLUMN IF NOT EXISTS sort_order integer NULL;

COMMENT ON COLUMN public.positions.parent_position_id IS
  'Reports-to position within the same tenant. Defines the organization chart hierarchy. '
  'NULL means a top-level position.';

COMMENT ON COLUMN public.positions.sort_order IS
  'Optional sibling ordering under the same parent_position_id.';

COMMENT ON COLUMN public.positions.level IS
  'Optional display/order helper for job titles. Not the hierarchy source of truth — '
  'use parent_position_id for reporting lines.';

-- ── 2) Constraints ───────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.positions'::regclass
      AND conname = 'positions_parent_position_id_fkey'
  ) THEN
    ALTER TABLE public.positions
      ADD CONSTRAINT positions_parent_position_id_fkey
      FOREIGN KEY (parent_position_id)
      REFERENCES public.positions (id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.positions'::regclass
      AND conname = 'positions_parent_not_self_check'
  ) THEN
    ALTER TABLE public.positions
      ADD CONSTRAINT positions_parent_not_self_check
      CHECK (parent_position_id IS NULL OR parent_position_id <> id);
  END IF;
END $$;

-- ── 3) Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_positions_org_parent_position_id
  ON public.positions (organization_id, parent_position_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_positions_parent_sort_title
  ON public.positions (parent_position_id, sort_order, title)
  WHERE deleted_at IS NULL;

-- ── 4) Parent hierarchy validation ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_position_parent_hierarchy_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_row public.positions%ROWTYPE;
  cycle_detected boolean;
BEGIN
  IF NEW.parent_position_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_position_id = NEW.id THEN
    RAISE EXCEPTION
      'positions: position cannot be its own parent (id=%)',
      NEW.id;
  END IF;

  SELECT *
    INTO parent_row
  FROM public.positions p
  WHERE p.id = NEW.parent_position_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'positions: parent position % does not exist',
      NEW.parent_position_id;
  END IF;

  IF parent_row.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION
      'positions: parent position % does not belong to organization %',
      NEW.parent_position_id,
      NEW.organization_id;
  END IF;

  IF parent_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'positions: parent position % is archived',
      NEW.parent_position_id;
  END IF;

  IF NOT parent_row.is_active THEN
    RAISE EXCEPTION
      'positions: parent position % is not active',
      NEW.parent_position_id;
  END IF;

  WITH RECURSIVE chain AS (
    SELECT p.id, p.parent_position_id, 1 AS depth
    FROM public.positions p
    WHERE p.id = NEW.parent_position_id
    UNION ALL
    SELECT p.id, p.parent_position_id, c.depth + 1
    FROM public.positions p
    INNER JOIN chain c ON p.id = c.parent_position_id
    WHERE c.depth < 256
  )
  SELECT EXISTS (
    SELECT 1
    FROM chain
    WHERE chain.id = NEW.id
  )
  INTO cycle_detected;

  IF cycle_detected THEN
    RAISE EXCEPTION
      'positions: assigning parent % would create a cycle for position %',
      NEW.parent_position_id,
      NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assert_position_parent_hierarchy_valid() IS
  'Validates parent_position_id: same org, active, not archived, not self, no cycles.';

DROP TRIGGER IF EXISTS trg_positions_parent_hierarchy_valid ON public.positions;
CREATE TRIGGER trg_positions_parent_hierarchy_valid
  BEFORE INSERT OR UPDATE OF parent_position_id, organization_id
  ON public.positions
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_position_parent_hierarchy_valid();

COMMIT;

NOTIFY pgrst, 'reload schema';
