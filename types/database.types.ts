/**
 * Supabase `public` schema typings — infrastructure layer.
 *
 * Reflects the LIVE database schema AFTER migration 20260413_returns_module_full_sync.sql
 * is applied. Columns are ordered as they appear in `information_schema.columns`
 * (creation order) to make future diffing easy.
 *
 * For a fully-regenerated file run:
 *   `npx supabase gen types typescript --project-id <ref> > types/database.types.ts`
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---------------------------------------------------------------------------
// return_items (physical return line items; renamed from `returns`)
// ---------------------------------------------------------------------------

/**
 * `public.return_items` row shape — includes all columns added through
 * migration 20260413 (item_name, conditions, notes, photo_evidence, etc.).
 * Legacy columns (raw_return_data, product_id, unit_sale_price,
 * amazon_fees_lost, return_shipping_fee, currency, condition_note) are
 * preserved as nullable to protect historical data.
 */
export type ReturnItemsRow = {
  /** Primary key. */
  id: string;
  /** FK to `stores` — resolves marketplace channel. */
  order_id: string | null;
  /** Carrier / seller return label scan code. */
  lpn: string | null;
  /** Workflow status: received | pending_evidence | ready_for_claim | claim_filed | closed. */
  status: string;
  /** Tenant FK. */
  organization_id: string | null;
  /** FK to `stores`. */
  store_id: string | null;
  /** FK to `pallets` (denormalised from package). */
  pallet_id: string | null;
  /** FK to `packages`. */
  package_id: string | null;
  /** Legacy JSONB blob — preserved for historical records. */
  raw_return_data: Json | null;
  created_at: string;
  /** Legacy FK to products catalog — preserved. */
  product_id: string | null;
  /** Legacy pricing fields — preserved. */
  unit_sale_price: number | null;
  amazon_fees_lost: number | null;
  return_shipping_fee: number | null;
  currency: string | null;
  /** Legacy free-text condition note — superseded by `conditions` array + `notes`. */
  condition_note: string | null;
  /** Seller RMA / authorisation number. Added in 20260402120000. */
  rma_number: string | null;
  /** Marketplace channel label (e.g. "Amazon"). */
  marketplace: string | null;
  // --- Added by migration 20260413 ---
  /** Human-readable product name. */
  item_name: string | null;
  /** Defect/condition labels array (e.g. ["damaged","expired"]). */
  conditions: string[] | null;
  /** General operator notes. */
  notes: string | null;
  /** Structured photo gallery JSONB. */
  photo_evidence: Json | null;
  expiration_date: string | null;
  batch_number: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  product_identifier: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string | null;
  /** Estimated reimbursement value in USD. */
  estimated_value: number | null;
  /** Soft-delete timestamp — NULL means active. */
  deleted_at: string | null;
  /** `expected_packages.id` when receive linked this unit to an expectation row. */
  expected_item_id?: string | null;
  expected_product_id?: string | null;
  scanned_product_id?: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
  identifier_resolution_source?: string | null;
  identifier_resolution_meta?: Json | null;
  product_match_status?: string | null;
  product_review_required?: boolean | null;
  product_resolved_at?: string | null;
  product_resolved_by?: string | null;
  // --- PostgREST embed (list selects only) ---
  stores?: { name: string; platform: string } | null;
};

/** @deprecated Use `ReturnItemsRow` — alias for table rename `returns` → `return_items`. */
export type ReturnsRow = ReturnItemsRow;

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

/**
 * `public.packages` row shape — includes all columns added through
 * migration 20260413.
 */
export type PackagesRow = {
  id: string;
  pallet_id: string | null;
  tracking_number: string | null;
  status: string | null;
  organization_id: string | null;
  store_id: string | null;
  expected_item_count: number | null;
  actual_item_count: number | null;
  created_at: string | null;
  carrier_name: string | null;
  rma_number: string | null;
  // --- Added by migration 20260413 ---
  manifest_url: string | null;
  /** Operator / receiving free-text notes (replaces legacy `discrepancy_note`). */
  notes: string | null;
  order_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string | null;
  /** Soft-delete timestamp — NULL means active. */
  deleted_at: string | null;
  /** Exterior / damage — up to 3 public media URLs (canonical; replaces legacy `photo_url`). */
  outside_photo_urls: string[] | null;
  /** Interior contents — up to 3 public media URLs (canonical; replaces legacy `photo_opened_url`). */
  inside_photo_urls: string[] | null;
  /** Packing slip pages — up to 3 public media URLs (canonical; replaces legacy slip/label columns). */
  slip_photo_urls: string[] | null;
  /** Parsed packing-slip lines [{sku, expected_qty, description}]. */
  manifest_data: Json | null;
  /**
   * Physical carton / box barcode (operator lock field).
   * Renamed from legacy `slip_id` (migration 20260511140000).
   */
  package_code: string | null;
  /** Packing-slip document id on paper (often `S…`) — column `packages.id_slip_contents`. */
  id_slip_contents: string | null;
  // --- PostgREST embed ---
  stores?: { name: string; platform: string } | null;
};

// ---------------------------------------------------------------------------
// pallets
// ---------------------------------------------------------------------------

/**
 * `public.pallets` row shape — includes all columns added through
 * migration 20260413.
 */
export type PalletsRow = {
  id: string;
  pallet_number: string;
  status: string | null;
  organization_id: string | null;
  store_id: string | null;
  item_count: number | null;
  created_at: string | null;
  tracking_number: string | null;
  /** Marketplace / removal order id (see migration 20260705120000_pallets_order_id). */
  order_id: string | null;
  /** Primary carrier for this receiving pallet (BOX SCAN saves here). */
  carrier_name: string | null;
  notes: string | null;
  // --- Added by migration 20260413 ---
  created_by: string | null;
  updated_by: string | null;
  updated_at: string | null;
  /** Pallet overview images (canonical; replaces legacy `photo_url`). */
  pallet_photo_urls: string[] | null;
  /** Bill of lading images (canonical; replaces legacy `bol_photo_url`). */
  bol_photo_urls: string[] | null;
  /** Shipping label / manifest scans (canonical; replaces legacy `manifest_photo_url`). */
  shipping_label_urls: string[] | null;
  /** Soft-delete timestamp — NULL means active. */
  deleted_at: string | null;
  // --- PostgREST embed ---
  stores?: { name: string; platform: string } | null;
};

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

/**
 * `public.profiles` row shape — workspace user directory.
 * `organization_id` is the tenant FK referencing `organization_settings.organization_id`
 * (no standalone `organizations` or `companies` table exists — Rule 5).
 */
export type ProfileRow = {
  /** PK — mirrors `auth.users.id`. */
  id: string;
  /** Tenant FK → `organization_settings.organization_id`. NOT NULL in practice. */
  organization_id: string | null;
  full_name: string | null;
  /** Roles: super_admin | admin | operator */
  role: string | null;
  /** Preferred FK → `public.roles.id` (migration 20260621100000). */
  role_id: string | null;
  /** Public URL of profile photo in the `profiles` storage bucket. */
  photo_url: string | null;
  created_at: string;
  updated_at: string | null;
};

// ---------------------------------------------------------------------------
// roles (access foundation)
// ---------------------------------------------------------------------------

export type RoleScope = "system" | "tenant";

/**
 * `public.roles` — scoped role catalog (system vs tenant).
 */
export type RolesRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scope: RoleScope;
  is_system: boolean;
  is_assignable: boolean;
  created_at: string;
};

// ---------------------------------------------------------------------------
// claim_submissions
// Protected: created_by column and status values (including 'failed').
// ---------------------------------------------------------------------------

/**
 * `public.claim_submissions` row shape.
 * PROTECTED: Do not remove `created_by` or alter the `status` value set.
 * Status values: pending | ready_to_send | submitted | failed | investigating | closed.
 */
export type ClaimSubmissionsRow = {
  id: string;
  /** Tenant FK — uses `organization_id` (rename migration 20260409 NOT applied to live DB). */
  organization_id: string | null;
  store_id: string | null;
  return_id: string | null;
  status: string | null;
  submission_id: string | null;
  claim_amount: number | null;
  currency: string | null;
  reimbursement_amount: number | null;
  source_payload: Json | null;
  /** PROTECTED — set by the Python AI agent on submission. */
  created_by: string | null;
  created_at: string | null;
  // --- Added by migration 20260413 ---
  updated_at: string | null;
  /** URL to the filed claim report / confirmation PDF (set by Python agent). */
  report_url: string | null;
};

// ---------------------------------------------------------------------------
// platform_settings (singleton: id = true)
// ---------------------------------------------------------------------------

export type PlatformSettingsRow = {
  id: boolean;
  app_name: string;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// organization_settings
// ---------------------------------------------------------------------------

/**
 * `public.organization_settings` row shape.
 */
export type OrganizationSettingsRow = {
  id: string;
  /** Tenant FK — `organization_id` (rename to company_id NOT applied to live DB). */
  organization_id: string | null;
  is_ai_label_ocr_enabled: boolean | null;
  default_claim_evidence: Json | null;
  logo_url: string | null;
  credentials: Json | null;
  updated_at: string | null;
  // --- Added by migration 20260413 ---
  is_ai_packing_slip_ocr_enabled: boolean | null;
  /** Human-readable tenant label shown in admin workspace picker. */
  company_display_name: string | null;
  /** Pre-selected store FK for new returns/packages in this org. */
  default_store_id: string | null;
  /** Enables verbose debug logging/UI for this tenant. */
  is_debug_mode_enabled: boolean | null;
};

// ---------------------------------------------------------------------------
// package_items (operator ITEM SCAN — one row per scanned unit)
// ---------------------------------------------------------------------------

export type PackageItemsRow = {
  id: string;
  organization_id: string;
  package_id: string;
  store_id: string | null;
  slip_content_id: string | null;
  scanned_barcode: string;
  match_kind: string;
  quantity: number;
  /** Item-level discrepancy chips (see `lib/scanner/item-unit-discrepancy-tags.ts`). */
  discrepancy_tags: string[] | null;
  expiry_date: string | null;
  lot_number: string | null;
  evidence_urls: string[] | null;
  created_at: string;
  created_by: string | null;
};

// ---------------------------------------------------------------------------
// slip_contents (BOX scan GPT lines)
// ---------------------------------------------------------------------------

export type SlipContentsRow = {
  id: string;
  organization_id: string;
  package_id: string;
  store_id: string | null;
  /** Denormalized packing-slip id for this line row. */
  slip_code: string | null;
  rma_number: string | null;
  upc: string | null;
  fnsku: string | null;
  description: string | null;
  quantity: number;
  condition: string | null;
  /** Line flags JSON, e.g. `{ "missing": true }` — migration `20260641130000_slip_contents_notes.sql`. */
  notes?: string | null;
  sort_index: number;
  created_at: string;
  ocr_text?: string | null;
  ocr_product_name?: string | null;
  ocr_confidence?: number | null;
  parsed_asin?: string | null;
  parsed_fnsku?: string | null;
  parsed_sku?: string | null;
  parsed_upc?: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
  identifier_resolution_source?: string | null;
  identifier_resolution_meta?: Json | null;
  product_review_required?: boolean | null;
};

// ---------------------------------------------------------------------------
// Database type map
// ---------------------------------------------------------------------------

/** Minimal `Database` shape for Returns Processing — extend as needed. */
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        /**
         * FK: profiles.organization_id → public.organizations(id)
         * (migration 20260622100000_profiles_organization_id_fk_organizations.sql;
         * supersedes 20260414 target of organization_settings for PostgREST embeds.)
         */
        Relationships: [
          {
            foreignKeyName: "profiles_organization_id_fkey";
            columns: ["organization_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      return_items: {
        Row: ReturnItemsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      slip_contents: {
        Row: SlipContentsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      package_items: {
        Row: PackageItemsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      packages: {
        Row: PackagesRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      pallets: {
        Row: PalletsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      claim_submissions: {
        Row: ClaimSubmissionsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      organization_settings: {
        Row: OrganizationSettingsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
      platform_settings: {
        Row: PlatformSettingsRow;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
