export type CatalogGroupDimension =
  | "vendor"
  | "category"
  | "brand"
  | "map_sku"
  | "map_asin"
  | "map_fnsku"
  | "map_upc";

export type CatalogGroupRow = {
  key: string;
  label: string;
  product_count: number;
  missing_image: number;
  missing_sku: number;
  missing_asin: number;
  missing_fnsku: number;
  missing_upc: number;
  active_count: number;
  filter_vendor_id?: string | null;
  /** When products have no `vendor_id` but a vendor display name, filter the grid with this search string. */
  filter_vendor_name?: string | null;
  filter_category_id?: string | null;
  filter_brand?: string | null;
  filter_search?: string | null;
  /** False = aggregate-only row (no per-product drilldown in the group tree). */
  allow_members?: boolean;
};
