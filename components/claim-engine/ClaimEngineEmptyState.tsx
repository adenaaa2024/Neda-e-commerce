import Link from "next/link";
import type { ReactNode } from "react";

import { CLAIM_ENGINE_CARD_CLASS } from "./claim-engine-ui";

export function ClaimEngineEmptyState({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className={`${CLAIM_ENGINE_CARD_CLASS} px-6 py-12 text-center`}>
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{title}</p>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">{description}</p>
      {children ? <div className="mt-4 text-sm text-slate-600 dark:text-slate-300">{children}</div> : null}
      {action ? (
        <Link
          href={action.href}
          className="mt-4 inline-flex text-sm font-semibold text-sky-600 hover:text-sky-500 dark:text-sky-400"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
