/**
 * Build original-parity-ddl.sql from pre-* viewdefs in same run folder (append package_code).
 * Called by main-v206-package-code-inventory-views-original-parity-apply.ts
 */
import fs from "node:fs";
import path from "node:path";

const RUN = process.env.V206_RUN_ID ?? "20260522T180000Z";
const dir = path.join(
  process.cwd(),
  ".cursor/audit-reports/main-v206-package-code-inventory-views-original-parity-apply",
  RUN,
);

function patchScanned(sql: string): string {
  let s = sql;
  s = s.replace(
    /p\.id_slip_contents AS slip_code,\n            r\.sku,/,
    "p.id_slip_contents AS slip_code,\n            max(nullif(trim(both from p.package_code::text), '')) AS package_code,\n            r.sku,",
  );
  s = s.replace(
    /scanned_grouped\.slip_code,\n            scanned_grouped\.sku,/,
    "scanned_grouped.slip_code,\n            scanned_grouped.package_code,\n            scanned_grouped.sku,",
  );
  s = s.replace(
    /total_scanned::numeric AS scanned_qty\n   FROM with_package_count;/,
    "total_scanned::numeric AS scanned_qty,\n    package_code\n   FROM with_package_count;",
  );
  return s;
}

function patchItem(sql: string): string {
  let s = sql;
  s = s.replace(
    /NULL::text AS product_identifier\n           FROM expected_packages ep/,
    "NULL::text AS product_identifier,\n            NULL::text AS package_code\n           FROM expected_packages ep",
  );
  s = s.replace(
    /s\.slip_code,\n            s\.sku,/,
    "s.slip_code,\n            s.package_code,\n            s.sku,",
  );
  s = s.replace(
    /expected_totals\.slip_code,\n            expected_totals\.sku,/g,
    "expected_totals.slip_code,\n            expected_totals.package_code,\n            expected_totals.sku,",
  );
  s = s.replace(
    /scanned_totals\.slip_code,\n            scanned_totals\.sku,/,
    "scanned_totals.slip_code,\n            scanned_totals.package_code,\n            scanned_totals.sku,",
  );
  s = s.replace(
    /combined_totals\.slip_code,\n            max\(combined_totals\.order_id\)/,
    "combined_totals.slip_code,\n            max(combined_totals.package_code) AS package_code,\n            max(combined_totals.order_id)",
  );
  s = s.replace(
    /item_grouped\.slip_code,\n            item_grouped\.order_id,/,
    "item_grouped.slip_code,\n            item_grouped.package_code,\n            item_grouped.order_id,",
  );
  s = s.replace(
    /total_scanned - total_expected AS variance_qty\n   FROM with_package_count;/,
    "total_scanned - total_expected AS variance_qty,\n    package_code\n   FROM with_package_count;",
  );
  return s;
}

function patchStatus(sql: string): string {
  return sql.replace(
    /END AS status\n   FROM v_inventory_item_status/,
    "END AS status,\n    max(package_code) AS package_code\n   FROM v_inventory_item_status",
  );
}

const scanned = patchScanned(fs.readFileSync(path.join(dir, "pre-v_scanned_items_counted.sql"), "utf8"));
const item = patchItem(fs.readFileSync(path.join(dir, "pre-v_inventory_item_status.sql"), "utf8"));
const status = patchStatus(fs.readFileSync(path.join(dir, "pre-v_inventory_status.sql"), "utf8"));

const ddl = [
  "-- MAIN V206 — original parity package_code (append-only columns)",
  "-- original ref: kxsvedvpjldygtdbylsy",
  "BEGIN;",
  "CREATE OR REPLACE VIEW public.v_scanned_items_counted AS",
  scanned.trim().replace(/;\s*$/, "") + ";",
  "CREATE OR REPLACE VIEW public.v_inventory_item_status AS",
  item.trim().replace(/;\s*$/, "") + ";",
  "CREATE OR REPLACE VIEW public.v_inventory_status AS",
  status.trim().replace(/;\s*$/, "") + ";",
  "NOTIFY pgrst, 'reload schema';",
  "COMMIT;",
  "",
].join("\n");

fs.writeFileSync(path.join(dir, "original-parity-ddl.sql"), ddl);
console.log("wrote", path.join(dir, "original-parity-ddl.sql"));
