/**
 * Neda Quantity-Based Dynamic Color Matrix — scanned_count vs expected_count.
 * Used for Step 3 item rows, progress hairline, and aggregate container framing.
 */

export type NedaQtyRowPresentation = {
  label: string;
  rowBg: string;
  rowBorder: string;
  badge: { borderColor: string; backgroundColor: string; color: string };
  matchedRing: boolean;
};

const NEUTRAL_BADGE = {
  borderColor: "rgba(148,163,184,0.38)",
  backgroundColor: "rgba(30,41,59,0.45)",
  color: "rgba(226,232,240,0.92)",
};

function neutralRow(): NedaQtyRowPresentation {
  return {
    label: "Awaiting",
    rowBg: "rgba(15, 23, 42, 0.55)",
    rowBorder: "rgba(148, 163, 184, 0.22)",
    badge: NEUTRAL_BADGE,
    matchedRing: false,
  };
}

/** Progressive match — faint graphite green deepening with each scanned unit. */
function progressiveGraphiteGreen(scanned: number, expected: number): NedaQtyRowPresentation {
  const t = Math.min(1, Math.max(0, scanned / Math.max(1, expected)));
  const borderAlpha = 0.14 + t * 0.72;
  const bgAlpha = 0.08 + t * 0.34;
  const sat = 0.35 + t * 0.55;
  return {
    label: "IN PROGRESS",
    rowBg: `rgba(12, 28, 24, ${bgAlpha})`,
    rowBorder: `rgba(52, 87, 72, ${borderAlpha})`,
    badge: {
      borderColor: `rgba(52, 211, 153, ${0.22 + t * 0.45})`,
      backgroundColor: `rgba(6, 44, 34, ${0.18 + t * 0.38})`,
      color: `rgba(167, 243, 208, ${sat})`,
    },
    matchedRing: false,
  };
}

/** Completed match — premium dark metallic green. */
function completedMetallicGreen(): NedaQtyRowPresentation {
  return {
    label: "RECEIVED",
    rowBg: "linear-gradient(135deg, rgba(4, 47, 36, 0.72) 0%, rgba(6, 78, 59, 0.58) 48%, rgba(2, 44, 34, 0.68) 100%)",
    rowBorder: "rgba(4, 120, 87, 0.95)",
    badge: {
      borderColor: "rgba(16, 185, 129, 0.92)",
      backgroundColor: "rgba(4, 47, 36, 0.72)",
      color: "#bbf7d0",
    },
    matchedRing: true,
  };
}

/** Under-quantity at finalize — warehouse matte red. */
function underMatteRed(): NedaQtyRowPresentation {
  return {
    label: "UNDER",
    rowBg: "rgba(69, 10, 10, 0.38)",
    rowBorder: "rgba(153, 27, 27, 0.72)",
    badge: {
      borderColor: "rgba(185, 28, 28, 0.82)",
      backgroundColor: "rgba(69, 10, 10, 0.52)",
      color: "#fecaca",
    },
    matchedRing: false,
  };
}

/** Over-quantity — metallic yellow / bronze warning. */
function overBronzeMetallic(): NedaQtyRowPresentation {
  return {
    label: "OVER",
    rowBg: "linear-gradient(135deg, rgba(69, 26, 3, 0.42) 0%, rgba(120, 53, 15, 0.38) 55%, rgba(92, 45, 12, 0.45) 100%)",
    rowBorder: "rgba(180, 134, 52, 0.88)",
    badge: {
      borderColor: "rgba(217, 168, 68, 0.9)",
      backgroundColor: "rgba(92, 45, 12, 0.48)",
      color: "#fde68a",
    },
    matchedRing: false,
  };
}

/**
 * Row / container sheen from scanned vs expected counts.
 * @param discrepancyMode — true when finalize/close package is open with qty mismatch audit.
 */
export function nedaQuantityRowPresentation(
  expectedQty: number,
  scannedQty: number,
  discrepancyMode: boolean,
): NedaQtyRowPresentation {
  const exp = Math.max(0, Math.floor(Number(expectedQty) || 0));
  const scn = Math.max(0, Math.floor(Number(scannedQty) || 0));

  if (scn > exp || (exp <= 0 && scn > 0)) {
    return overBronzeMetallic();
  }

  if (discrepancyMode) {
    if (exp > 0 && scn < exp) return underMatteRed();
    if (exp > 0 && scn >= exp) return completedMetallicGreen();
    return neutralRow();
  }

  if (exp > 0 && scn === exp) return completedMetallicGreen();
  if (exp > 0 && scn > 0 && scn < exp) return progressiveGraphiteGreen(scn, exp);
  return neutralRow();
}

/** Progress hairline / stat accent from aggregate totals. */
export function nedaQuantityProgressColor(expectedQty: number, scannedQty: number): string {
  const exp = Math.max(0, Math.floor(Number(expectedQty) || 0));
  const scn = Math.max(0, Math.floor(Number(scannedQty) || 0));
  if (exp <= 0) return "rgba(148,163,184,0.35)";
  if (scn === 0) return "rgba(148,163,184,0.28)";
  if (scn > exp) return "rgba(180, 134, 52, 0.88)";
  if (scn === exp) return "rgba(4, 120, 87, 0.92)";
  const t = Math.min(1, scn / exp);
  return `rgba(52, 87, 72, ${0.28 + t * 0.55})`;
}

export function nedaQuantityScannedStatColor(expectedQty: number, scannedQty: number): string {
  const exp = Math.max(0, Math.floor(Number(expectedQty) || 0));
  const scn = Math.max(0, Math.floor(Number(scannedQty) || 0));
  if (exp <= 0) return "rgba(248, 250, 252, 0.95)";
  if (scn === 0) return "rgba(148, 163, 184, 0.75)";
  if (scn === exp) return "#6ee7b7";
  if (scn > exp) return "#fde68a";
  return "rgba(248, 250, 252, 0.95)";
}

export function nedaQuantityRemainingStatColor(expectedQty: number, scannedQty: number): string {
  const exp = Math.max(0, Math.floor(Number(expectedQty) || 0));
  const scn = Math.max(0, Math.floor(Number(scannedQty) || 0));
  const rem = Math.max(0, exp - scn);
  if (exp <= 0) return "rgba(148, 163, 184, 0.75)";
  if (scn === 0) return "rgba(148, 163, 184, 0.75)";
  if (rem > 0 && scn < exp) return "#fca5a5";
  return "#6ee7b7";
}

/** Expected-item card ring / background from matrix presentation. */
export function nedaQuantityCardSurfaceStyle(vis: NedaQtyRowPresentation): {
  background: string;
  borderColor: string;
  borderWidth: number;
  boxShadow: string;
} {
  const accent =
    vis.label === "RECEIVED"
      ? "rgba(4, 120, 87, 0.42)"
      : vis.label === "IN PROGRESS"
        ? vis.rowBorder
        : vis.label === "UNDER"
          ? "rgba(153, 27, 27, 0.55)"
          : vis.label === "OVER"
            ? "rgba(180, 134, 52, 0.5)"
            : "transparent";
  const borderWidth = vis.label === "Awaiting" ? 1 : 2;
  return {
    background: vis.rowBg,
    borderColor: vis.rowBorder,
    borderWidth,
    boxShadow: `inset 3px 0 0 0 ${vis.rowBorder}${accent ? `, 0 0 0 1px ${accent}` : ""}`,
  };
}
