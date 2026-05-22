import "server-only";

import type { AmazonSpApiCredentials } from "./sp-api";
import { getAmazonAccessToken } from "./sp-api";
import { amazonSpCredentialsLookComplete } from "../amazon-marketplace-credentials";
import {
  filterValidAmazonRetailMarketplaceIds,
  isAmazonRetailMarketplaceId,
} from "../amazon-retail-marketplace-ids";
import { supabaseServer } from "../supabase-server";

const DEFAULT_REPORTS_HOST = "https://sellingpartnerapi-na.amazon.com";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";

function finalizeMarketplacesForStore(
  storeMarketplaceId: string | null | undefined,
  rawFromCredentials: string[],
): { ok: true; marketplaceIds: string[] } | { ok: false; error: string } {
  const valid = filterValidAmazonRetailMarketplaceIds(rawFromCredentials);
  if (rawFromCredentials.length > 0 && valid.length === 0) {
    return {
      ok: false,
      error:
        "Configured Amazon marketplace_id values are not recognized retail marketplaces.",
    };
  }
  const store = n(storeMarketplaceId).toUpperCase();
  if (store && isAmazonRetailMarketplaceId(store) && !valid.includes(store)) {
    valid.unshift(store);
  }
  const marketplaceIds = valid.length ? valid : [DEFAULT_MARKETPLACE_ID];
  return { ok: true, marketplaceIds };
}

function n(v: unknown): string {
  return String(v ?? "").trim();
}

function credsRecordToLwa(credentials: Record<string, unknown>): AmazonSpApiCredentials | null {
  const lwaClientId = n(credentials.lwa_client_id ?? credentials.lwaClientId ?? credentials.client_id);
  const lwaClientSecret = n(
    credentials.lwa_client_secret ?? credentials.lwaClientSecret ?? credentials.client_secret,
  );
  const refreshToken = n(credentials.refresh_token ?? credentials.refreshToken);
  if (!lwaClientId || !lwaClientSecret || !refreshToken) return null;
  return { lwaClientId, lwaClientSecret, refreshToken };
}

function marketplaceIdsFromCredentials(credentials: Record<string, unknown>): string[] {
  const single = n(credentials.marketplace_id ?? credentials.marketplaceId);
  if (single) return [single];
  const multi = n(credentials.marketplace_ids ?? credentials.marketplaceIds);
  if (!multi) return [];
  return multi
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function reportsHostFromCredentials(credentials: Record<string, unknown>): string {
  const ep = n(credentials.endpoint ?? credentials.sp_api_endpoint ?? credentials.reports_endpoint);
  if (!ep) return DEFAULT_REPORTS_HOST;
  return ep.startsWith("http") ? ep.replace(/\/$/, "") : `https://${ep.replace(/\/$/, "")}`;
}

function awsKeysFromCredentials(credentials: Record<string, unknown>): {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
} | null {
  const accessKeyId = n(
    credentials.aws_access_key ??
      credentials.aws_access_key_id ??
      credentials.awsAccessKeyId ??
      process.env.AWS_ACCESS_KEY_ID,
  );
  const secretAccessKey = n(
    credentials.aws_secret_key ??
      credentials.aws_secret_access_key ??
      credentials.awsSecretAccessKey ??
      process.env.AWS_SECRET_ACCESS_KEY,
  );
  const region = n(credentials.aws_region ?? credentials.awsRegion ?? process.env.AWS_REGION) || "us-east-1";
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, region };
}

export type ReportsApiContext = {
  credentials: AmazonSpApiCredentials;
  accessToken: string;
  marketplaceIds: string[];
  reportsHost: string;
  aws: { accessKeyId: string; secretAccessKey: string; region: string };
  storeMarketplaceId: string | null;
};

function contextFromCredRecord(
  credObj: Record<string, unknown>,
  storeMpRaw: string | null,
): { ok: true; ctx: Omit<ReportsApiContext, "accessToken"> } | { ok: false; error: string } {
  if (!amazonSpCredentialsLookComplete(credObj)) {
    return { ok: false, error: "Amazon SP-API credentials are incomplete." };
  }
  const lwa = credsRecordToLwa(credObj);
  if (!lwa) return { ok: false, error: "Amazon LWA credentials could not be parsed." };
  const rawIds = marketplaceIdsFromCredentials(credObj);
  const fin = finalizeMarketplacesForStore(storeMpRaw, rawIds);
  if (!fin.ok) return fin;
  const aws = awsKeysFromCredentials(credObj);
  if (!aws) {
    return {
      ok: false,
      error:
        "AWS signing keys are required for Reports API (aws_access_key / aws_secret_key on marketplace credentials or AWS_ACCESS_KEY_ID env).",
    };
  }
  return {
    ok: true,
    ctx: {
      credentials: lwa,
      marketplaceIds: fin.marketplaceIds,
      reportsHost: reportsHostFromCredentials(credObj),
      aws,
      storeMarketplaceId: storeMpRaw,
    },
  };
}

/**
 * Resolve LWA + marketplace + SigV4 keys for Reports API (store-scoped).
 * Never returns secret values in error messages beyond field names.
 */
export async function resolveReportsApiContext(
  organizationId: string,
  storeId: string,
): Promise<{ ok: true; context: ReportsApiContext } | { ok: false; error: string }> {
  const { data: store, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id, organization_id, marketplace_id, platform, marketplaces(id, provider, credentials)")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (storeErr || !store) {
    return { ok: false, error: "Store not found for this organization." };
  }

  const storeMpRaw = n((store as { marketplace_id?: string | null }).marketplace_id) || null;
  const mpRel = (store as { marketplaces?: { provider?: string; credentials?: unknown } | null }).marketplaces;
  if (mpRel?.credentials && typeof mpRel.credentials === "object" && !Array.isArray(mpRel.credentials)) {
    const credObj = mpRel.credentials as unknown as Record<string, unknown>;
    if (n(mpRel.provider) === "amazon_sp_api") {
      const built = contextFromCredRecord(credObj, storeMpRaw);
      if (built.ok) {
        try {
          const t = await getAmazonAccessToken(built.ctx.credentials);
          return { ok: true, context: { ...built.ctx, accessToken: t.accessToken } };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "Amazon token request failed." };
        }
      }
      return built;
    }
  }

  const { data: keyRow } = await supabaseServer
    .from("organization_api_keys")
    .select("api_key")
    .eq("organization_id", organizationId)
    .eq("name", "amazon_sp_api")
    .maybeSingle();

  const rawKey = (keyRow as { api_key?: string } | null)?.api_key;
  if (rawKey?.trim()) {
    try {
      const parsed = JSON.parse(rawKey) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const built = contextFromCredRecord(parsed as unknown as Record<string, unknown>, storeMpRaw);
        if (built.ok) {
          try {
            const t = await getAmazonAccessToken(built.ctx.credentials);
            return { ok: true, context: { ...built.ctx, accessToken: t.accessToken } };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "Amazon token request failed." };
          }
        }
        return built;
      }
    } catch {
      /* fall through */
    }
  }

  const { data: mpRows } = await supabaseServer
    .from("marketplaces")
    .select("credentials")
    .eq("organization_id", organizationId)
    .eq("provider", "amazon_sp_api")
    .limit(3);

  for (const row of mpRows ?? []) {
    const credObj = (row as { credentials?: unknown }).credentials;
    if (!credObj || typeof credObj !== "object" || Array.isArray(credObj)) continue;
    const built = contextFromCredRecord(credObj as unknown as Record<string, unknown>, storeMpRaw);
    if (built.ok) {
      try {
        const t = await getAmazonAccessToken(built.ctx.credentials);
        return { ok: true, context: { ...built.ctx, accessToken: t.accessToken } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Amazon token request failed." };
      }
    }
  }

  return {
    ok: false,
    error:
      "Amazon Selling Partner credentials are not configured for this workspace or store.",
  };
}
