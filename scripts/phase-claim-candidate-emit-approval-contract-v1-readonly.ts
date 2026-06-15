/**
 * PHASE-CLAIM-CANDIDATE-EMIT-APPROVAL-CONTRACT-V1 — readonly materialize
 *   npx tsx scripts/phase-claim-candidate-emit-approval-contract-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildClaimCandidateEmitApprovalContractV1 } from "../lib/claims/contracts/claim-candidate-emit-approval-contract-v1";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-approval-contract-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const payload = buildClaimCandidateEmitApprovalContractV1("yes");

  const manifest = {
    phase: "PHASE-CLAIM-CANDIDATE-EMIT-APPROVAL-CONTRACT-V1",
    run_id: id,
    mode: "approval_contract_only",
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    contract_file: "lib/claims/contracts/claim-candidate-emit-approval-contract-v1.ts",
    approved_families: payload.approved_families,
    preview_only_families: payload.preview_only_families,
    emit_status_rules: payload.emit_status_rules,
    money_field_rules: payload.money_field_rules,
    emit_rules_count: payload.emit_rules.length,
    no_emit_rules_count: payload.no_emit_rules.length,
    migration_needed: payload.migration_needed,
    approval_required: payload.approval_required,
    SAFE_TO_IMPLEMENT_EMITTER: payload.SAFE_TO_IMPLEMENT_EMITTER,
    prerequisite_safe_to_approve: payload.prerequisite_safe_to_approve_claim_candidate_emit,
    prerequisite_evidence_run_id: payload.prerequisite_evidence_run_id,
    emit_blockers: payload.emit_blockers,
    NEXT_PROMPT: payload.NEXT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "contract.json"), JSON.stringify(payload, null, 2));

  const summary = `# PHASE-CLAIM-CANDIDATE-EMIT-APPROVAL-CONTRACT-V1

**Run:** ${id}  
**Mode:** approval contract only — no DB writes, no emitter

## Prerequisite
- Phase: ${payload.prerequisite_phase}
- Evidence: \`${payload.prerequisite_evidence_run_id}\`
- SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT: **${payload.prerequisite_safe_to_approve_claim_candidate_emit}**

## preview_only_families (Wave-1)
${payload.preview_only_families.map((f) => `- \`${f}\``).join("\n")}

## approved_families
${payload.approved_families.map((f) => `- \`${f}\` → ${payload.v3_to_claim_family_map[f as keyof typeof payload.v3_to_claim_family_map].claim_families.join(", ")}`).join("\n")}

## emit_rules (${payload.emit_rules.length})
${payload.emit_rules.map((r) => `- **${r.rule_id}**${r.required ? " (required)" : ""}: ${r.description}`).join("\n")}

## no_emit_rules (${payload.no_emit_rules.length})
${payload.no_emit_rules.map((r) => `- **${r.rule_id}**${r.review_signal_only ? " [review_signal_only]" : ""}: ${r.description}`).join("\n")}

## review_signal_only statuses
${payload.review_signal_only_statuses.map((s) => `- \`${s}\``).join("\n")}

## dedupe_contract
- Format: \`${payload.dedupe_contract.dedupe_key_format}\`
- Insert: ${payload.dedupe_contract.insert_when.join("; ")}
- Update: ${payload.dedupe_contract.update_when.join("; ")}
- Skip: ${payload.dedupe_contract.skip_when.join("; ")}

## migration_needed
**${payload.migration_needed}** — ${payload.migration_notes}

## SAFE_TO_IMPLEMENT_EMITTER
**${payload.SAFE_TO_IMPLEMENT_EMITTER}**

### Blockers
${payload.emit_blockers.map((b) => `- ${b}`).join("\n")}

## NEXT_PROMPT
\`\`\`
${payload.NEXT_PROMPT}
\`\`\`
`;

  fs.writeFileSync(path.join(outDir, "summary.md"), summary);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
