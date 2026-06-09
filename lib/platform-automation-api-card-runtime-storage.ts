import pg from "pg";

import {
  automationScopeKey,
  parseAutomationPersisted,
  writeStoreAutomationSettings,
} from "./platform-automation-scope-storage";
import { computeApiCardNextRun, normalizeStoreAutomationSettings } from "./platform-automation-schedule";
import {
  DEFAULT_STORE_AUTOMATION_SETTINGS,
  EMPTY_REMOVAL_CRON_RUNTIME,
  type ApiAutomationCardSchedule,
  type FinancesArchiveApiSchedule,
  type RemovalCronRuntimeState,
  type StoreAutomationSettings,
} from "./platform-automation-settings-types";

export type ApiCardScheduleKey = "reimbursements_api" | "settlement_api" | "finances_archive_api";

function cardSchedule(
  scope: StoreAutomationSettings,
  key: ApiCardScheduleKey,
): ApiAutomationCardSchedule | FinancesArchiveApiSchedule {
  return scope[key];
}

export async function readApiCardCronRuntimeFromPg(
  client: pg.Client | pg.PoolClient,
  organizationId: string,
  storeId: string,
  card: ApiCardScheduleKey,
): Promise<RemovalCronRuntimeState> {
  const r = await client.query(`SELECT automation_settings FROM public.platform_settings WHERE id = true LIMIT 1`);
  const doc = parseAutomationPersisted(r.rows[0]?.automation_settings);
  const scope = doc.scopes[automationScopeKey(organizationId, storeId)];
  return cardSchedule(scope ?? DEFAULT_STORE_AUTOMATION_SETTINGS, card).cron_runtime ?? {
    ...EMPTY_REMOVAL_CRON_RUNTIME,
  };
}

export async function persistApiCardCronRuntime(args: {
  connectionString: string;
  organizationId: string;
  storeId: string;
  card: ApiCardScheduleKey;
  patch: Partial<RemovalCronRuntimeState>;
  scheduleForNextRun?: ApiAutomationCardSchedule | FinancesArchiveApiSchedule;
}): Promise<RemovalCronRuntimeState> {
  const client = new pg.Client({
    connectionString: args.connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT automation_settings FROM public.platform_settings WHERE id = true LIMIT 1 FOR UPDATE`,
    );
    const raw = r.rows[0]?.automation_settings;
    const doc = parseAutomationPersisted(raw);
    const key = automationScopeKey(args.organizationId, args.storeId);
    const currentScope =
      doc.scopes[key] ?? normalizeStoreAutomationSettings(DEFAULT_STORE_AUTOMATION_SETTINGS);
    const prevSchedule = cardSchedule(currentScope, args.card);
    const prev = prevSchedule.cron_runtime ?? { ...EMPTY_REMOVAL_CRON_RUNTIME };
    const nextRunAt =
      args.patch.next_run_at !== undefined
        ? args.patch.next_run_at
        : args.scheduleForNextRun
          ? (computeApiCardNextRun(args.scheduleForNextRun)?.toISOString() ?? null)
          : prev.next_run_at;

    const merged: RemovalCronRuntimeState = {
      ...prev,
      ...args.patch,
      next_run_at: nextRunAt,
    };

    const updatedScope: StoreAutomationSettings = {
      ...currentScope,
      [args.card]: {
        ...prevSchedule,
        cron_runtime: merged,
      },
    };
    const persisted = writeStoreAutomationSettings(raw, args.organizationId, args.storeId, updatedScope);
    await client.query(
      `UPDATE public.platform_settings SET automation_settings = $1::jsonb, updated_at = now() WHERE id = true`,
      [JSON.stringify(persisted)],
    );
    return merged;
  } finally {
    await client.end();
  }
}
