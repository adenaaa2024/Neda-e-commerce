import pg from "pg";

import {
  automationScopeKey,
  parseAutomationPersisted,
  writeStoreAutomationSettings,
} from "./platform-automation-scope-storage";
import { normalizeStoreAutomationSettings } from "./platform-automation-schedule";
import { computeRemovalRecentNextRun } from "./platform-automation-schedule";
import {
  DEFAULT_STORE_AUTOMATION_SETTINGS,
  EMPTY_REMOVAL_CRON_RUNTIME,
  type RemovalCronRuntimeState,
  type StoreAutomationSettings,
} from "./platform-automation-settings-types";
import { productionPostgresUrl } from "./production-db-bind";

export async function readRemovalCronRuntimeFromPg(
  client: pg.Client | pg.PoolClient,
  organizationId: string,
  storeId: string,
): Promise<RemovalCronRuntimeState> {
  const r = await client.query(`SELECT automation_settings FROM public.platform_settings WHERE id = true LIMIT 1`);
  const raw = r.rows[0]?.automation_settings;
  const doc = parseAutomationPersisted(raw);
  const scope = doc.scopes[automationScopeKey(organizationId, storeId)];
  return scope?.removal_api_sync.cron_runtime ?? { ...EMPTY_REMOVAL_CRON_RUNTIME };
}

export async function persistRemovalCronRuntime(
  organizationId: string,
  storeId: string,
  patch: Partial<RemovalCronRuntimeState>,
  settingsForNextRun?: StoreAutomationSettings["removal_api_sync"],
): Promise<RemovalCronRuntimeState> {
  const dbUrl = productionPostgresUrl();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT automation_settings FROM public.platform_settings WHERE id = true LIMIT 1 FOR UPDATE`,
    );
    const raw = r.rows[0]?.automation_settings;
    const doc = parseAutomationPersisted(raw);
    const key = automationScopeKey(organizationId, storeId);
    const currentScope =
      doc.scopes[key] ?? normalizeStoreAutomationSettings(DEFAULT_STORE_AUTOMATION_SETTINGS);
    const prev = currentScope.removal_api_sync.cron_runtime ?? { ...EMPTY_REMOVAL_CRON_RUNTIME };
    const nextRunAt =
      patch.next_run_at !== undefined
        ? patch.next_run_at
        : settingsForNextRun
          ? (computeRemovalRecentNextRun(settingsForNextRun)?.toISOString() ?? null)
          : prev.next_run_at;

    const merged: RemovalCronRuntimeState = {
      ...prev,
      ...patch,
      next_run_at: nextRunAt,
    };

    const updatedScope: StoreAutomationSettings = {
      ...currentScope,
      removal_api_sync: {
        ...currentScope.removal_api_sync,
        cron_runtime: merged,
      },
    };
    const persisted = writeStoreAutomationSettings(raw, organizationId, storeId, updatedScope);
    await client.query(
      `UPDATE public.platform_settings SET automation_settings = $1::jsonb, updated_at = now() WHERE id = true`,
      [JSON.stringify(persisted)],
    );
    return merged;
  } finally {
    await client.end();
  }
}
