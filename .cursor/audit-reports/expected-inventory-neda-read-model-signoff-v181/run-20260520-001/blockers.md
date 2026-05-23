# Blockers

**Overall:** PASS

- **Note:** `NEXT_PUBLIC_SUPABASE_URL` still targets the original Supabase project; runtime UI uses that unless you align NEXT_PUBLIC_* to staging. This audit used **STAGING_*** for read probes only (no production queries).


- ep_db_ep_linkage_select: column expected_packages.product_match_status does not exist
