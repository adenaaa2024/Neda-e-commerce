/**
 * Read-only validation: ImportDescriptorV1 ↔ AMAZON_REPORT_REGISTRY ↔ generic route Phase-4.
 */

import { resolveAmazonImportSyncKind } from "../pipeline/amazon-report-registry";
import {
  AMAZON_REPORT_REGISTRY,
  type AmazonSyncKind,
  requiresPhase4Generic,
} from "../pipeline/amazon-report-registry";
import type { RawReportType } from "../raw-report-types";
import { classifyCsvHeadersRuleBased } from "../csv-import-detected-type";
import {
  expectedPhase4EffectsForKind,
  getAmazonDescriptorByKind,
} from "./amazon-import-descriptors-v1";
import {
  PHASE4_EFFECT_KEYS_LIVE_IN_GENERIC_ROUTE,
  type DescriptorValidationIssue,
  type ImportDescriptorV1,
  type Phase4EffectRef,
  validateImportDescriptorV1Shape,
} from "./import-descriptor-v1";

function effectKeys(effects: Phase4EffectRef[]): string[] {
  return effects.map((e) => e.effect_key).sort();
}

export function validateDescriptorAgainstRegistry(d: ImportDescriptorV1): DescriptorValidationIssue[] {
  const issues: DescriptorValidationIssue[] = [...validateImportDescriptorV1Shape(d)];

  if (!d.registry_mirror || !d.import_kind || d.import_kind === "UNKNOWN") {
    return issues;
  }

  const kind = d.import_kind;
  const reg = AMAZON_REPORT_REGISTRY[kind];

  if (d.staging_table !== reg.stage_target_table) {
    issues.push({
      code: "staging_table_mismatch",
      descriptor_id: d.descriptor_id,
      message: `staging_table: descriptor=${d.staging_table} registry=${reg.stage_target_table}`,
    });
  }
  if (d.staging_dedupe_mode !== reg.dedupeMode) {
    issues.push({
      code: "dedupe_mismatch",
      descriptor_id: d.descriptor_id,
      message: `staging_dedupe_mode: descriptor=${d.staging_dedupe_mode} registry=${reg.dedupeMode}`,
    });
  }
  if (d.staging_conflict_columns !== reg.conflictColumns) {
    issues.push({
      code: "conflict_columns_mismatch",
      descriptor_id: d.descriptor_id,
      message: `staging_conflict_columns drift for ${kind}`,
    });
  }
  if (d.sync_target_table !== reg.sync_target_table) {
    issues.push({
      code: "sync_target_mismatch",
      descriptor_id: d.descriptor_id,
      message: `sync_target_table: descriptor=${String(d.sync_target_table)} registry=${String(reg.sync_target_table)}`,
    });
  }

  const supportsGeneric = reg.supports_generic;
  if (supportsGeneric && d.phase4_effects.length === 0) {
    issues.push({
      code: "missing_phase4",
      descriptor_id: d.descriptor_id,
      message: `${kind} supports_generic=true but phase4_effects is empty`,
    });
  }
  if (!supportsGeneric && d.phase4_effects.length > 0) {
    issues.push({
      code: "unexpected_phase4",
      descriptor_id: d.descriptor_id,
      message: `${kind} supports_generic=false but phase4_effects is non-empty`,
    });
  }

  return issues;
}

export function validateDescriptorPhase4AgainstGenericRoute(d: ImportDescriptorV1): DescriptorValidationIssue[] {
  const issues: DescriptorValidationIssue[] = [];
  if (!d.import_kind || d.import_kind === "UNKNOWN") return issues;

  const expected = expectedPhase4EffectsForKind(d.import_kind);
  const got = d.phase4_effects;

  if (effectKeys(got).join(",") !== effectKeys(expected).join(",")) {
    issues.push({
      code: "phase4_route_mismatch",
      descriptor_id: d.descriptor_id,
      message: `${d.import_kind} phase4 expected [${effectKeys(expected).join(", ")}] got [${effectKeys(got).join(", ")}]`,
    });
  }

  for (const eff of got) {
    if (!PHASE4_EFFECT_KEYS_LIVE_IN_GENERIC_ROUTE.includes(eff.effect_key)) {
      issues.push({
        code: "phase4_not_live",
        descriptor_id: d.descriptor_id,
        message: `effect ${eff.effect_key} is not live in generic route`,
      });
    }
  }

  const regSupports = requiresPhase4Generic(d.import_kind);
  if (regSupports !== got.length > 0) {
    issues.push({
      code: "phase4_supports_generic_mismatch",
      descriptor_id: d.descriptor_id,
      message: `requiresPhase4Generic=${regSupports} vs phase4_effects.length=${got.length}`,
    });
  }

  return issues;
}

export function validateDescriptorReportTypeRouting(d: ImportDescriptorV1): DescriptorValidationIssue[] {
  const issues: DescriptorValidationIssue[] = [];
  if (!d.report_type || !d.import_kind) return issues;

  const resolved = resolveAmazonImportSyncKind(d.report_type);
  if (resolved !== d.import_kind) {
    issues.push({
      code: "report_type_kind_mismatch",
      descriptor_id: d.descriptor_id,
      message: `report_type ${d.report_type} resolves to ${resolved}, descriptor import_kind=${d.import_kind}`,
    });
  }
  return issues;
}

export function validateAllAmazonRegistryMirrorDescriptors(): DescriptorValidationIssue[] {
  const issues: DescriptorValidationIssue[] = [];
  const kinds = Object.keys(AMAZON_REPORT_REGISTRY).filter((k) => k !== "UNKNOWN") as AmazonSyncKind[];

  for (const kind of kinds) {
    const d = getAmazonDescriptorByKind(kind);
    if (!d) {
      issues.push({ code: "missing_descriptor", message: `No descriptor for AmazonSyncKind ${kind}` });
      continue;
    }
    if (!d.registry_mirror) {
      issues.push({
        code: "missing_mirror",
        descriptor_id: d.descriptor_id,
        message: `${kind} must have registry_mirror descriptor`,
      });
    }
    issues.push(
      ...validateDescriptorAgainstRegistry(d),
      ...validateDescriptorPhase4AgainstGenericRoute(d),
      ...validateDescriptorReportTypeRouting(d),
    );
  }

  return issues;
}

/** Header fixtures: detected RawReportType must match descriptor import_kind when both are Amazon pipeline kinds. */
export function validateDetectorAlignsWithDescriptor(
  headers: string[],
  expectKind: AmazonSyncKind,
): DescriptorValidationIssue[] {
  const { reportType } = classifyCsvHeadersRuleBased(headers);
  const d = getAmazonDescriptorByKind(expectKind);
  const issues: DescriptorValidationIssue[] = [];

  if (!d) {
    issues.push({ code: "no_descriptor", message: `No descriptor for ${expectKind}` });
    return issues;
  }

  const detectedKind = resolveAmazonImportSyncKind(reportType as RawReportType);
  if (detectedKind !== expectKind) {
    issues.push({
      code: "detector_kind_mismatch",
      descriptor_id: d.descriptor_id,
      message: `headers classify as ${reportType} (${detectedKind}), expected ${expectKind}`,
    });
  }
  return issues;
}

export function collectAllDescriptorValidationIssues(
  extras: ImportDescriptorV1[] = [],
): DescriptorValidationIssue[] {
  return [...validateAllAmazonRegistryMirrorDescriptors(), ...extras.flatMap((d) => [
    ...validateDescriptorAgainstRegistry(d),
    ...validateDescriptorPhase4AgainstGenericRoute(d),
    ...validateImportDescriptorV1Shape(d),
  ])];
}
