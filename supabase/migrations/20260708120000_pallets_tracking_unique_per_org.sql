-- One active pallet per organization per normalized tracking number (case- and space-insensitive).
-- Clears tracking_number on duplicate rows (keeps earliest id) so the unique index can be applied safely.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        organization_id,
        lower(regexp_replace(btrim(tracking_number), '[[:space:]]', '', 'g'))
      ORDER BY id
    ) AS rn
  FROM public.pallets
  WHERE deleted_at IS NULL
    AND tracking_number IS NOT NULL
    AND btrim(tracking_number) <> ''
)
UPDATE public.pallets p
SET tracking_number = NULL
FROM ranked r
WHERE p.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS pallets_org_tracking_normalized_uidx
  ON public.pallets (
    organization_id,
    lower(regexp_replace(btrim(tracking_number), '[[:space:]]', '', 'g'))
  )
  WHERE deleted_at IS NULL
    AND tracking_number IS NOT NULL
    AND btrim(tracking_number) <> '';

COMMENT ON INDEX public.pallets_org_tracking_normalized_uidx IS
  'Prevents duplicate receiving pallets for the same normalized carrier tracking within an organization.';
