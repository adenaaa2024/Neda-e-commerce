import type {
  ClaimEligibilityClaimSource,
  ClaimModuleDomain,
  ClaimPolicyV1,
  EnabledClaimDomains,
} from "./claim-policy-types";

/** UI + policy keys for phase-1 module scope (stored under claim_policy.enabled_claim_domains). */
export const CLAIM_MODULE_DOMAIN_KEYS = [
  "returns",
  "warehouse_inventory",
  "carrier_shipments",
  "removals",
  "financial",
  "expected_mismatch",
  "marketplace",
] as const satisfies readonly ClaimModuleDomain[];

export type ClaimModuleDomainMeta = {
  key: ClaimModuleDomain;
  label: string;
  description: string;
  /** Phase 1: operator may toggle in Settings. */
  configurablePhase1: boolean;
};

export const CLAIM_MODULE_DOMAIN_OPTIONS: ClaimModuleDomainMeta[] = [
  {
    key: "returns",
    label: "Returns",
    description: "Scanner issues, return items, and ready-for-claim operational paths.",
    configurablePhase1: true,
  },
  {
    key: "warehouse_inventory",
    label: "Warehouse / inventory",
    description: "QC and inventory discrepancy claims (phase 2).",
    configurablePhase1: false,
  },
  {
    key: "carrier_shipments",
    label: "Carrier / shipments",
    description: "Inbound carrier and shipment discrepancy claims (phase 2).",
    configurablePhase1: false,
  },
  {
    key: "removals",
    label: "Removals",
    description: "Amazon removal import candidates (phase 2).",
    configurablePhase1: false,
  },
  {
    key: "financial",
    label: "Financial",
    description: "Settlement and reimbursement discrepancy claims (phase 2).",
    configurablePhase1: false,
  },
  {
    key: "expected_mismatch",
    label: "Expected mismatch",
    description: "API-only expected inventory without scan evidence (phase 2).",
    configurablePhase1: false,
  },
  {
    key: "marketplace",
    label: "Marketplace filing",
    description: "Open cases and submit claims to marketplace APIs.",
    configurablePhase1: false,
  },
];

export const DEFAULT_DISABLED_CLAIM_DOMAINS: EnabledClaimDomains = {
  returns: false,
  warehouse_inventory: false,
  carrier_shipments: false,
  removals: false,
  financial: false,
  expected_mismatch: false,
  marketplace: false,
};

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

/** Parse enabled_claim_domains — missing keys default to false. */
export function parseEnabledClaimDomains(raw: unknown): EnabledClaimDomains {
  const out = { ...DEFAULT_DISABLED_CLAIM_DOMAINS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const key of CLAIM_MODULE_DOMAIN_KEYS) {
    if (o[key] === true) out[key] = true;
    else if (o[key] === false) out[key] = false;
  }
  return out;
}

export function isClaimModuleDomainEnabled(
  policy: ClaimPolicyV1,
  domain: ClaimModuleDomain,
): boolean {
  return policy.enabled_claim_domains[domain] === true;
}

/** Map eligibility source (+ optional import table) to a module domain. */
export function resolveClaimModuleDomain(
  claimSource: ClaimEligibilityClaimSource,
  sourceTable?: string | null,
): ClaimModuleDomain {
  if (claimSource === "scanner_operator_issue" || claimSource === "ready_for_claim") {
    return "returns";
  }
  if (claimSource === "warehouse_qc_issue") {
    return "warehouse_inventory";
  }
  if (claimSource === "expected_mismatch") {
    return "expected_mismatch";
  }
  const st = trimOrNull(sourceTable)?.toLowerCase() ?? "";
  if (st === "amazon_removals") return "removals";
  if (st === "amazon_removal_shipments") return "carrier_shipments";
  if (st === "amazon_returns") return "returns";
  if (st === "return_items" || st === "returns") return "returns";
  return "financial";
}

export function claimModuleDomainLabel(domain: ClaimModuleDomain): string {
  return CLAIM_MODULE_DOMAIN_OPTIONS.find((d) => d.key === domain)?.label ?? domain;
}

export function claimModuleScopeDisabledMessage(domain: ClaimModuleDomain): string {
  return `${claimModuleDomainLabel(domain)} claims are disabled for this organization.`;
}

const MARKETPLACE_CLAIM_PERMISSIONS = new Set([
  "claims.marketplace.open_case",
  "claims.marketplace.submit",
  "claims.marketplace.follow_up",
]);

export function isMarketplaceClaimPermission(action: string): boolean {
  return MARKETPLACE_CLAIM_PERMISSIONS.has(action);
}
