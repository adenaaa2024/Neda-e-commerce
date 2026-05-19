/** Shared labels/styles for scanner product resolution chips (no React import). */

export type ScannerResolutionBadge = {
  key: string;
  label: string;
  borderColor: string;
  backgroundColor: string;
  color: string;
};

function badge(
  key: string,
  label: string,
  borderColor: string,
  backgroundColor: string,
  color: string,
): ScannerResolutionBadge {
  return { key, label, borderColor, backgroundColor, color };
}

export function scannerProductResolutionBadges(input: {
  identifier_resolution_status?: string | null;
  product_match_status?: string | null;
  product_review_required?: boolean | null;
  identifier_resolution_source?: string | null;
}): ScannerResolutionBadge[] {
  const out: ScannerResolutionBadge[] = [];
  const st = String(input.identifier_resolution_status ?? "").trim().toLowerCase();
  const pm = String(input.product_match_status ?? "").trim().toLowerCase();
  const rev = Boolean(input.product_review_required);
  const src = String(input.identifier_resolution_source ?? "").trim().toLowerCase();

  if (src === "manual_override") {
    out.push(
      badge(
        "manual_override",
        "Manual override",
        "rgba(167,139,250,0.85)",
        "rgba(76,29,149,0.42)",
        "#ede9fe",
      ),
    );
  }

  if (pm === "mismatch") {
    out.push(
      badge(
        "mismatch",
        "Mismatch",
        "rgba(239,68,68,0.88)",
        "rgba(127,29,29,0.42)",
        "#fecaca",
      ),
    );
  }
  if (st === "resolved") {
    out.push(
      badge(
        "resolved",
        "Product linked",
        "rgba(16,185,129,0.82)",
        "rgba(6,95,70,0.45)",
        "#bbf7d0",
      ),
    );
  } else if (st === "ambiguous") {
    out.push(
      badge(
        "ambiguous",
        "Ambiguous",
        "rgba(245,158,11,0.85)",
        "rgba(120,53,15,0.42)",
        "#fde68a",
      ),
    );
  } else if (st === "unresolved") {
    out.push(
      badge(
        "unresolved",
        "Unresolved",
        "rgba(148,163,184,0.55)",
        "rgba(30,41,59,0.5)",
        "rgba(226,232,240,0.9)",
      ),
    );
  }

  if (rev && !out.some((b) => b.key === "mismatch")) {
    out.push(
      badge(
        "review",
        "Review",
        "rgba(96,165,250,0.75)",
        "rgba(30,58,138,0.45)",
        "#dbeafe",
      ),
    );
  }

  return out;
}
