"use client";

import { Info } from "lucide-react";

type CloseReviewDisclaimerProps = {
  scope: "box" | "shipment";
};

export function CloseReviewDisclaimer(props: CloseReviewDisclaimerProps) {
  const { scope } = props;
  const text =
    scope === "box"
      ? "Closing does not create claims. Issues saved as review evidence."
      : "Closing does not create claims. Issues saved as review evidence.";

  return (
    <p className="operator-shipment-close-review__disclaimer mt-1 flex items-start justify-center gap-1 text-[10px] font-medium leading-snug">
      <Info
        className="operator-shipment-close-review__disclaimer-icon mt-px h-3 w-3 shrink-0"
        strokeWidth={2.25}
        aria-hidden
      />
      <span>{text}</span>
    </p>
  );
}

type CloseReviewUnresolvedBlockProps = {
  labels: string[];
  displayMap: Record<string, string>;
};

function resolveUnresolvedBadges(
  labels: string[],
  displayMap: Record<string, string>,
): string[] {
  const badges: string[] = [];
  for (const label of labels) {
    if (label === "Missing / final shortage") {
      badges.push("Missing", "Final shortage");
      continue;
    }
    badges.push(displayMap[label] ?? label);
  }
  return badges;
}

export function CloseReviewUnresolvedBlock(props: CloseReviewUnresolvedBlockProps) {
  const { labels, displayMap } = props;
  if (labels.length === 0) return null;

  const badges = resolveUnresolvedBadges(labels, displayMap);

  return (
    <section
      className="operator-shipment-close-review__unresolved operator-shipment-close-review__unresolved-card mt-3 rounded-xl px-3 py-2"
      aria-label="Unresolved issues"
    >
      <p className="operator-shipment-close-review__unresolved-title text-[11px] font-bold uppercase tracking-wide leading-snug">
        Unresolved issues
      </p>
      <ul className="operator-shipment-close-review__unresolved-badges mt-1.5 flex flex-wrap gap-1.5">
        {badges.map((badge) => (
          <li key={badge}>
            <span className="operator-shipment-close-review__unresolved-badge">{badge}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
