"use client";

import type { AmbiguousProductChoice } from "../../app/returns/product-input-lookup-actions";

type Props = {
  choices: AmbiguousProductChoice[];
  disabled?: boolean;
  onPick: (choice: AmbiguousProductChoice) => void;
};

/**
 * Manual review when multiple distinct local products match the same scan (V196).
 */
export function AmbiguousProductPicker({ choices, disabled, onPick }: Props) {
  if (choices.length === 0) {
    return (
      <p className="text-xs text-amber-800 dark:text-amber-200">
        Multiple local products matched this identifier. Pick the correct product from PIM or adjust the scan code.
      </p>
    );
  }

  return (
    <ul className="mt-2 space-y-1.5">
      {choices.map((c) => (
        <li key={c.product_id}>
          <button
            type="button"
            disabled={disabled}
            className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-left text-xs transition hover:border-amber-500 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-600 dark:bg-slate-900 dark:hover:bg-amber-950/40"
            onClick={() => onPick(c)}
          >
            <span className="block font-semibold text-amber-950 dark:text-amber-100">
              {c.product_name?.trim() || "Unnamed product"}
            </span>
            <span className="mt-0.5 block font-mono text-[10px] text-amber-800/90 dark:text-amber-300/90">
              {[c.asin && `ASIN ${c.asin}`, c.fnsku && `FNSKU ${c.fnsku}`, c.sku && `SKU ${c.sku}`, c.upc && `UPC ${c.upc}`]
                .filter(Boolean)
                .join(" · ") || c.product_id.slice(0, 8)}
              {c.map_row_count > 1 ? ` · ${c.map_row_count} map rows` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
