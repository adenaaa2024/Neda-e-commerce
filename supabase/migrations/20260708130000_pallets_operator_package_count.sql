-- Operator-declared box count at pallet creation (off-manifest / identification gate).
ALTER TABLE public.pallets
  ADD COLUMN IF NOT EXISTS operator_package_count integer NULL;

COMMENT ON COLUMN public.pallets.operator_package_count IS
  'Physical carton count the operator entered when creating a receiving pallet (off-manifest gate).';
