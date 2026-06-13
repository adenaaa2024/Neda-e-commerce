"use client";

import {
  MENORIX_MODULE_VIEW_MODES,
  MENORIX_MODULE_VIEW_SWITCH_CLASS,
  type MenorixModuleViewMode,
  menorixModuleViewSwitchBtn,
} from "./menorix-module-ui";

export function MenorixModuleViewSwitcher({
  value,
  onChange,
  modes = MENORIX_MODULE_VIEW_MODES,
  compact,
}: {
  value: MenorixModuleViewMode;
  onChange: (mode: MenorixModuleViewMode) => void;
  modes?: { id: MenorixModuleViewMode; label: string }[];
  compact?: boolean;
}) {
  const visible = compact ? modes.filter((m) => ["card", "table", "queue"].includes(m.id)) : modes;

  return (
    <div className={MENORIX_MODULE_VIEW_SWITCH_CLASS} role="group" aria-label="View mode">
      {visible.map((m) => (
        <button
          key={m.id}
          type="button"
          className={menorixModuleViewSwitchBtn(value === m.id)}
          onClick={() => onChange(m.id)}
          aria-pressed={value === m.id}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
