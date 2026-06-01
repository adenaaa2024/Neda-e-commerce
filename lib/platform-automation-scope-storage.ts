import {
  DEFAULT_PLATFORM_AUTOMATION_SETTINGS,
  DEFAULT_STORE_AUTOMATION_SETTINGS,
  type PlatformAutomationPersisted,
  type StoreAutomationSettings,
} from "./platform-automation-settings-types";
import { normalizeStoreAutomationSettings } from "./platform-automation-schedule";

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const DEFAULT_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

export function automationScopeKey(organizationId: string, storeId: string): string {
  return `${organizationId.trim().toLowerCase()}:${storeId.trim().toLowerCase()}`;
}

function isLegacyFlatSettings(raw: Record<string, unknown>): boolean {
  return (
    raw.version !== 2 &&
    (raw.product_enrichment != null || raw.removal_api_sync != null) &&
    raw.scopes == null
  );
}

function legacyToStoreSettings(raw: Record<string, unknown>): StoreAutomationSettings {
  return normalizeStoreAutomationSettings({
    product_enrichment: raw.product_enrichment,
    removal_api_sync: raw.removal_api_sync,
  });
}

/** Parse persisted JSONB; returns v2 document (migrates legacy flat on read). */
export function parseAutomationPersisted(raw: unknown): PlatformAutomationPersisted {
  if (!raw || typeof raw !== "object") {
    return { version: 2, scopes: {} };
  }
  const src = raw as Record<string, unknown>;
  if (src.version === 2 && src.scopes && typeof src.scopes === "object") {
    const scopes: PlatformAutomationPersisted["scopes"] = {};
    for (const [key, value] of Object.entries(src.scopes as Record<string, unknown>)) {
      scopes[key] = normalizeStoreAutomationSettings(value);
    }
    return { version: 2, scopes };
  }
  if (isLegacyFlatSettings(src)) {
    const legacy = legacyToStoreSettings(src);
    return {
      version: 2,
      scopes: {
        [automationScopeKey(DEFAULT_ORG, DEFAULT_STORE)]: legacy,
      },
    };
  }
  return { version: 2, scopes: {} };
}

export function readStoreAutomationSettings(
  raw: unknown,
  organizationId: string,
  storeId: string,
): StoreAutomationSettings {
  const doc = parseAutomationPersisted(raw);
  const key = automationScopeKey(organizationId, storeId);
  return doc.scopes[key] ?? DEFAULT_STORE_AUTOMATION_SETTINGS;
}

export function writeStoreAutomationSettings(
  raw: unknown,
  organizationId: string,
  storeId: string,
  settings: StoreAutomationSettings,
): PlatformAutomationPersisted {
  const doc = parseAutomationPersisted(raw);
  const key = automationScopeKey(organizationId, storeId);
  return {
    version: 2,
    scopes: {
      ...doc.scopes,
      [key]: normalizeStoreAutomationSettings(settings),
    },
  };
}

/** Legacy scheduler/scripts: first scope or flat defaults. */
export function readLegacyPlatformAutomationSettings(raw: unknown): typeof DEFAULT_PLATFORM_AUTOMATION_SETTINGS {
  const doc = parseAutomationPersisted(raw);
  const first = Object.values(doc.scopes)[0];
  if (first) {
    return {
      product_enrichment: first.product_enrichment,
      removal_api_sync: first.removal_api_sync,
    };
  }
  return DEFAULT_PLATFORM_AUTOMATION_SETTINGS;
}
