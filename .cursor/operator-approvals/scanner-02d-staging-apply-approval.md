# SCANNER-02D — Staging apply approval (return_items resolver + RPC patch)

Supabase project ref/name: eiqfaapyumhixxoeltgu  
Environment: dev/staging  
Approved by: Maysam Ebrahimi  
Approved at UTC: 2026-05-20T15:00:00Z

APPROVED_TO_APPLY_SCANNER_02D_STAGING_MIGRATIONS=false

Scope (historical — schema on staging via ENV-04R clone; **do not re-apply** without new approval):
- Apply only: `20260815151000_return_items_product_id_if_missing.sql`
- Apply only: `20260815150000_return_items_rename_and_scanner_resolver.sql`
- Apply only: `20260815152000_list_workspace_return_items_rpc_patch.sql` (new)
- Was applied on pre-clone project `kxsvedvpjldygtdbylsy`; clone target `eiqfaapyumhixxoeltgu` inherits schema
- No production apply
- No drop/recreate `return_items`
- No `products` / `product_identifier_map` mutations
- No Amazon API / OpenAI
