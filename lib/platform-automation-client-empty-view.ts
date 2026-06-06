/** Client-safe empty automation view when server read fails (no Supabase imports). */

import { readPlatformAutomationApiFlags } from "./platform-automation-api-flags";
import { normalizeStoreAutomationSettings } from "./platform-automation-schedule";
import {
  EMPTY_AUTOMATION_RUNTIME,
  EMPTY_MANUAL_RUNS,
  type StoreAutomationSettingsView,
} from "./platform-automation-settings-types";

export function buildClientEmptyAutomationView(
  organizationId: string,
  storeId: string,
): StoreAutomationSettingsView {
  const settings = normalizeStoreAutomationSettings({});
  return {
    ...settings,
    organization_id: organizationId,
    store_id: storeId,
    updated_at: null,
    manual_runs: { ...EMPTY_MANUAL_RUNS },
    api_flags: readPlatformAutomationApiFlags(),
    runtime: {
      product_enrichment: { ...EMPTY_AUTOMATION_RUNTIME },
      removal_api_sync: {
        recent: { ...EMPTY_AUTOMATION_RUNTIME },
        historical_backfill: { ...EMPTY_AUTOMATION_RUNTIME },
      },
      reimbursements_api: { ...EMPTY_AUTOMATION_RUNTIME },
      settlement_api: { ...EMPTY_AUTOMATION_RUNTIME },
      finances_archive_api: { ...EMPTY_AUTOMATION_RUNTIME },
    },
  };
}
