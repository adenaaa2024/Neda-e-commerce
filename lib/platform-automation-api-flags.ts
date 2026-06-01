import {
  isAmazonFinancesApiIngestEnabled,
  isAmazonFinancesApiWorkerEnabled,
} from "./amazon/finances-api-worker-flags";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiRemovalOrderEnabled,
  isAmazonReportsApiRemovalShipmentEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "./amazon/reports-api-worker-flags";
import type { PlatformAutomationApiFlags } from "./platform-automation-settings-types";

export function readPlatformAutomationApiFlags(): PlatformAutomationApiFlags {
  return {
    reports_worker_enabled: isAmazonReportsApiWorkerEnabled(),
    reimbursements_enabled: isAmazonReportsApiReimbursementsEnabled(),
    settlement_enabled: isAmazonReportsApiSettlementEnabled(),
    removal_order_enabled: isAmazonReportsApiRemovalOrderEnabled(),
    removal_shipment_enabled: isAmazonReportsApiRemovalShipmentEnabled(),
    finances_worker_enabled: isAmazonFinancesApiWorkerEnabled(),
    finances_ingest_enabled: isAmazonFinancesApiIngestEnabled(),
  };
}

export type ApiFlagWarning = {
  disabled: boolean;
  title: string;
  detail: string;
};

export function reimbursementFlagWarning(flags: PlatformAutomationApiFlags): ApiFlagWarning {
  if (flags.reimbursements_enabled) {
    return { disabled: false, title: "", detail: "" };
  }
  if (!flags.reports_worker_enabled) {
    return {
      disabled: true,
      title: "Reports API worker disabled on this server",
      detail: "Set ENABLE_AMAZON_REPORTS_API_WORKER=true on the server.",
    };
  }
  return {
    disabled: true,
    title: "Reimbursements API disabled on this server",
    detail: "Set ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true (and master worker flag).",
  };
}

export function settlementFlagWarning(flags: PlatformAutomationApiFlags): ApiFlagWarning {
  if (flags.settlement_enabled) {
    return { disabled: false, title: "", detail: "" };
  }
  if (!flags.reports_worker_enabled) {
    return {
      disabled: true,
      title: "Reports API worker disabled on this server",
      detail: "Set ENABLE_AMAZON_REPORTS_API_WORKER=true on the server.",
    };
  }
  return {
    disabled: true,
    title: "Settlement API disabled on this server",
    detail: "Set ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true (and master worker flag).",
  };
}

export function removalFlagWarning(flags: PlatformAutomationApiFlags): ApiFlagWarning {
  if (flags.removal_order_enabled && flags.removal_shipment_enabled) {
    return { disabled: false, title: "", detail: "" };
  }
  if (!flags.reports_worker_enabled) {
    return {
      disabled: true,
      title: "Reports API worker disabled on this server",
      detail: "Set ENABLE_AMAZON_REPORTS_API_WORKER=true on the server.",
    };
  }
  const parts: string[] = [];
  if (!flags.removal_order_enabled) parts.push("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER");
  if (!flags.removal_shipment_enabled) parts.push("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT");
  return {
    disabled: true,
    title: "Removal / shipment API disabled on this server",
    detail: `Set ${parts.join(" and ")}=true (and master worker flag).`,
  };
}

export function financesFlagWarning(flags: PlatformAutomationApiFlags): ApiFlagWarning {
  if (flags.finances_ingest_enabled) {
    return { disabled: false, title: "", detail: "" };
  }
  if (!flags.finances_worker_enabled) {
    return {
      disabled: true,
      title: "Finances API worker disabled on this server",
      detail: "Set ENABLE_AMAZON_FINANCES_API_WORKER=true on the server.",
    };
  }
  return {
    disabled: true,
    title: "Finances archive ingest disabled on this server",
    detail: "Set ENABLE_AMAZON_FINANCES_API_INGEST=true (and master worker flag).",
  };
}
