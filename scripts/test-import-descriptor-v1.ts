/**
 * Read-only ImportDescriptorV1 validation tests.
 * No DB, no API, no AI.
 *
 * Run: `npm run test:import-descriptors-v1`
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  AMAZON_IMPORT_DESCRIPTORS_V1,
  AMAZON_REGISTRY_MIRROR_DESCRIPTORS_V1,
  expectedPhase4EffectsForKind,
  PHASE4_EFFECT_CATALOG,
} from "../lib/import/amazon-import-descriptors-v1";
import type { ImportDescriptorV1 } from "../lib/import/import-descriptor-v1";
import {
  collectAllDescriptorValidationIssues,
  validateDetectorAlignsWithDescriptor,
} from "../lib/import/import-descriptor-validation";
import {
  AMAZON_REPORT_REGISTRY,
  requiresPhase4Generic,
  type AmazonSyncKind,
} from "../lib/pipeline/amazon-report-registry";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "import-descriptors");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function loadPlannedFixtureDescriptors(): ImportDescriptorV1[] {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("upload-metadata-"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")) as ImportDescriptorV1)
    .filter((d) => Array.isArray(d.phase4_effects));
}

/** Detector ↔ descriptor alignment using amazon-report-headers fixtures. */
const DETECTOR_ALIGNMENT_CASES: { fixture: string; kind: AmazonSyncKind }[] = [
  { fixture: "reimbursements.json", kind: "REIMBURSEMENTS" },
  { fixture: "settlement_payment_detail.json", kind: "SETTLEMENT" },
  { fixture: "transactions_simple_summary.json", kind: "TRANSACTIONS" },
  { fixture: "reports_repository.json", kind: "REPORTS_REPOSITORY" },
  { fixture: "removal_order.json", kind: "REMOVAL_ORDER" },
  { fixture: "removal_shipment.json", kind: "REMOVAL_SHIPMENT" },
  { fixture: "safet_claims.json", kind: "SAFET_CLAIMS" },
  { fixture: "inventory_ledger_event.json", kind: "INVENTORY_LEDGER" },
  { fixture: "fba_customer_returns.json", kind: "FBA_RETURNS" },
  { fixture: "fulfilled_shipments.json", kind: "ALL_ORDERS" },
];

function main(): void {
  let passed = 0;
  const failures: string[] = [];

  const planned = loadPlannedFixtureDescriptors();
  const allIssues = collectAllDescriptorValidationIssues(planned);
  if (allIssues.length > 0) {
    for (const i of allIssues) {
      failures.push(`[${i.code}] ${i.descriptor_id ?? ""} ${i.message}`);
    }
  } else {
    passed++;
    console.log(`[OK]   registry mirror validation (${AMAZON_REGISTRY_MIRROR_DESCRIPTORS_V1.length} descriptors)`);
  }

  assert(AMAZON_IMPORT_DESCRIPTORS_V1.length === Object.keys(AMAZON_REPORT_REGISTRY).length, "descriptor count vs registry");
  passed++;
  console.log(`[OK]   descriptor count matches registry (${AMAZON_IMPORT_DESCRIPTORS_V1.length})`);

  const genericKinds = (Object.keys(AMAZON_REPORT_REGISTRY) as AmazonSyncKind[]).filter((k) =>
    requiresPhase4Generic(k),
  );
  for (const kind of genericKinds) {
    const effects = expectedPhase4EffectsForKind(kind);
    assert(effects.length > 0, `${kind} must have phase4 effects`);
    for (const e of effects) {
      const cat = PHASE4_EFFECT_CATALOG[e.effect_key];
      assert(cat, `catalog missing ${e.effect_key}`);
      assert(
        cat.import_kinds.includes(kind),
        `${e.effect_key} catalog does not list ${kind}`,
      );
    }
    passed++;
    console.log(`[OK]   phase4 catalog covers ${kind} → ${effects.map((x) => x.effect_key).join(",")}`);
  }

  const headerFixtureDir = path.join(process.cwd(), "tests", "fixtures", "amazon-report-headers");
  for (const { fixture, kind } of DETECTOR_ALIGNMENT_CASES) {
    const p = path.join(headerFixtureDir, fixture);
    if (!fs.existsSync(p)) {
      failures.push(`missing header fixture ${fixture}`);
      continue;
    }
    const { headers } = JSON.parse(fs.readFileSync(p, "utf8")) as { headers: string[] };
    const detIssues = validateDetectorAlignsWithDescriptor(headers, kind);
    if (detIssues.length) {
      for (const i of detIssues) failures.push(`[detector] ${fixture}: ${i.message}`);
    } else {
      passed++;
      console.log(`[OK]   detector ↔ descriptor ${kind} (${fixture})`);
    }
  }

  for (const p of planned) {
    if (p.registry_mirror) {
      failures.push(`planned fixture ${p.descriptor_id} must not use registry_mirror`);
    } else {
      passed++;
      console.log(`[OK]   planned fixture ${p.descriptor_id}`);
    }
  }

  if (failures.length) {
    console.error("\n--- FAILURES ---\n" + failures.join("\n"));
    process.exit(1);
  }

  console.log(`\nDone: ${passed} checks passed.`);
}

main();
