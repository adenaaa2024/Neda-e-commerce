/**
 * One-shot: build merged migration from original view snapshots + package gate.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SNAP = path.join(
  process.cwd(),
  ".cursor/audit-reports/inventory-views-bulk-orphan-ri-exclusion-migration/_original-snapshot",
);
const OUT = path.join(
  process.cwd(),
  "supabase/migrations/20260904120000_inventory_views_bulk_orphan_ri_exclusion.sql",
);

function patchScanned(def: string): string {
  let d = def.trim();
  d = d.replace(
    /LEFT JOIN packages p ON r\.package_id = p\.id/gi,
    "INNER JOIN public.packages p ON r.package_id = p.id",
  );
  d = d.replace(
    /FROM return_items r/gi,
    "FROM public.return_items r",
  );
  d = d.replace(
    /LEFT JOIN pallets pl/gi,
    "LEFT JOIN public.pallets pl",
  );
  if (!/WHERE r\.deleted_at IS NULL/i.test(d)) {
    throw new Error("scanned view missing deleted_at filter");
  }
  d = d.replace(
    /WHERE r\.deleted_at IS NULL/i,
    "WHERE r.deleted_at IS NULL AND r.package_id IS NOT NULL",
  );
  return d;
}

function qualifyItemOrStatus(def: string): string {
  return def
    .trim()
    .replace(/\bFROM v_scanned_items_counted\b/gi, "FROM public.v_scanned_items_counted")
    .replace(/\bFROM v_inventory_item_status\b/gi, "FROM public.v_inventory_item_status")
    .replace(/\bFROM expected_packages\b/gi, "FROM public.expected_packages")
    .replace(/\bLEFT JOIN products\b/gi, "LEFT JOIN public.products");
}

const scanned = patchScanned(fs.readFileSync(path.join(SNAP, "v_scanned_items_counted.sql"), "utf8"));
const item = qualifyItemOrStatus(fs.readFileSync(path.join(SNAP, "v_inventory_item_status.sql"), "utf8"));
const status = qualifyItemOrStatus(fs.readFileSync(path.join(SNAP, "v_inventory_status.sql"), "utf8"));

const sql = `-- INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION (merged)
-- Restores original-parity inventory view columns on staging and gates physical scans to package-anchored return_items.
-- Source: original live viewdefs + package_id IS NOT NULL on v_scanned_items_counted scanned_grouped CTE.
-- Staging apply: APPROVED_INVENTORY_VIEWS_BULK_ORPHAN_RI_EXCLUSION_STAGING=true

BEGIN;

DROP VIEW IF EXISTS public.v_inventory_status CASCADE;
DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;
DROP VIEW IF EXISTS public.v_scanned_items_counted CASCADE;

CREATE VIEW public.v_scanned_items_counted AS
${scanned};

CREATE VIEW public.v_inventory_item_status AS
${item};

CREATE VIEW public.v_inventory_status AS
${status};

COMMENT ON VIEW public.v_scanned_items_counted IS
  'Neda inventory: package-anchored scanned return_items only (deleted_at null, package_id not null). Excludes bulk orphan EP rows.';
COMMENT ON VIEW public.v_inventory_item_status IS
  'Neda inventory: expected_packages union package-anchored scanned totals; original-parity product spine columns.';
COMMENT ON VIEW public.v_inventory_status IS
  'Neda inventory: package-level rollup; scanned leg inherits package-anchored filter via v_scanned_items_counted.';

NOTIFY pgrst, 'reload schema';

COMMIT;
`;

fs.writeFileSync(OUT, sql + "\n");
console.log("Wrote", OUT);
