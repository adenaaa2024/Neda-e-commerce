/**
 * PHASE1-API-CONFIG-AND-CLAIM-INTAKE-INTEGRATION-WIRE — read-only audit.
 *
 *   npx tsx scripts/phase1-api-config-claim-intake-integration-audit.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { API_INTAKE_SETTINGS_INVENTORY, sourceToClaimIntakeMap } from "../lib/api-intake-settings-inventory";
import {
  CLAIM_INTAKE_GENERATOR_SOURCE_TABLES,
  CLAIM_INTAKE_IDEMPOTENCY_STRATEGY,
  isSettlementRowClaimableIntake,
} from "../lib/claim-intake-candidate-generators";
import { readPlatformAutomationApiFlags } from "../lib/platform-automation-api-flags";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/phase1-api-config-claim-intake-integration-wire", id);
  fs.mkdirSync(outDir, { recursive: true });

  const flags = readPlatformAutomationApiFlags();
  const output = {
    api_settings_inventory: API_INTAKE_SETTINGS_INVENTORY,
    source_to_claim_intake_map: sourceToClaimIntakeMap(),
    missing_settings: [
      !flags.reports_worker_enabled && "ENABLE_AMAZON_REPORTS_API_WORKER",
      !flags.removal_order_enabled && "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
      !flags.removal_shipment_enabled && "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
      !flags.reimbursements_enabled && "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
      !flags.settlement_enabled && "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
      !flags.finances_ingest_enabled && "ENABLE_AMAZON_FINANCES_API_INGEST",
    ].filter(Boolean),
    claim_intake_generators_status: Object.fromEntries(
      CLAIM_INTAKE_GENERATOR_SOURCE_TABLES.map((t) => [t, t === "amazon_settlements" ? "claimable_filter" : "wired"]),
    ),
    idempotency_strategy: CLAIM_INTAKE_IDEMPOTENCY_STRATEGY,
    ui_status_wiring: {
      endpoint: "/api/claims/intake/settings-status",
      generator_endpoint: "/api/claims/intake/generate-candidates",
      panels: ["ClaimIntakeSourcesPanel", "ClaimApiIntakeSettingsPanel"],
      auto_sync_on_load: false,
      manual_run: "explicit only",
    },
    settlement_claimable_samples: {
      reimbursement_line: isSettlementRowClaimableIntake({
        transaction_type: "FBA Inventory Reimbursement",
        order_id: "123",
        amount_total: 12.5,
      }),
      service_fee: isSettlementRowClaimableIntake({
        transaction_type: "Service Fee",
        amount_total: -5,
      }),
    },
    files_changed: [
      "lib/api-intake-settings-inventory.ts",
      "lib/claim-intake-candidate-generators.ts",
      "lib/claim-api-intake-settings-status.ts",
      "lib/claim-intake-sources.ts",
      "app/api/claims/intake/settings-status/route.ts",
      "app/api/claims/intake/generate-candidates/route.ts",
      "components/claim-engine/ClaimApiIntakeSettingsPanel.tsx",
      "app/claim-engine/inbox/ClaimInboxClient.tsx",
      "scripts/phase1-api-config-claim-intake-integration-audit.ts",
    ],
    SAFE_TO_COMMIT_PUSH: "yes — read-only status + dry-run default; apply gated by env",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main();
