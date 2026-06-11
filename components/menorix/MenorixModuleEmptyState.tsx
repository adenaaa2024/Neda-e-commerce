import type { ReactNode } from "react";

import { MENORIX_MODULE_CARD_CLASS } from "./menorix-module-ui";

export function MenorixModuleEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className={`${MENORIX_MODULE_CARD_CLASS} mx-auto max-w-md p-8 text-center`}>
      {icon ? <div className="mx-auto mb-3 flex justify-center opacity-70">{icon}</div> : null}
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-2 text-sm opacity-70">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
