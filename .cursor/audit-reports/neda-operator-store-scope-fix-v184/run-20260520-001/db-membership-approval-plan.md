# DB membership approval plan (optional — not executed)

No migrations or profile updates were applied in this run.

If operators should default to Sam without using the workspace switcher:

1. **Approve** updating `profiles.organization_id` for staging test accounts from RECOVRA (`39f5e74f-0690-4ad0-9edd-3a7f6dd7385b`) to Sam (`00000000-0000-0000-0000-000000000001`) — only for dedicated scanner QA users.
2. **Or** set `organization_settings.default_store_id` on RECOVRA if RECOVRA gains active stores later.
3. **Do not** hardcode Sam UUIDs in app routes; keep workspace picker + localStorage as the supported path for super_admin.

**Recommended:** keep profile on RECOVRA; select **Sam Distribution Inc** in workspace switcher (persisted key `workspace_selected_organization_id`).