import { CLAIM_INTAKE_SOURCES } from "@/lib/claim-intake-sources";
import { ClaimSourceBadge } from "./ClaimSourceBadge";
import { CLAIM_ENGINE_SECTION_CLASS } from "./claim-engine-ui";

const STATUS_LABEL: Record<string, string> = {
  live: "Live",
  partial: "Partial",
  planned: "Connector needed",
};

const STATUS_CLASS: Record<string, string> = {
  live: "text-emerald-700 dark:text-emerald-300",
  partial: "text-amber-700 dark:text-amber-300",
  planned: "text-slate-500 dark:text-slate-400",
};

export function ClaimIntakeSourcesPanel() {
  return (
    <div className={CLAIM_ENGINE_SECTION_CLASS}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Claim sources</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Intake lists claim_candidates from imports and generators. Physical scans enter via{" "}
        <strong className="text-foreground">Draft pool</strong>, not this inbox, until a future unified intake API
        exists.
      </p>
      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {CLAIM_INTAKE_SOURCES.map((s) => (
          <li key={s.kind} className="flex flex-wrap items-start gap-2 py-2.5 first:pt-0 last:pb-0">
            <ClaimSourceBadge kind={s.kind} />
            <span className={`text-[10px] font-semibold uppercase ${STATUS_CLASS[s.status]}`}>
              {STATUS_LABEL[s.status]}
            </span>
            <p className="w-full text-xs text-muted-foreground">
              {s.detail}
              {s.backend ? (
                <span className="mt-0.5 block font-mono text-[10px] text-slate-500 dark:text-slate-500">{s.backend}</span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
