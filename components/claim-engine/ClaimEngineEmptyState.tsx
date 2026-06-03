import Link from "next/link";
import type { ReactNode } from "react";

import { CLAIM_ENGINE_CARD_CLASS } from "./claim-engine-ui";

export function ClaimEngineEmptyState({
  title,
  description,
  children,
  action,
  secondaryAction,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  action?: { href: string; label: string };
  secondaryAction?: { href: string; label: string };
}) {
  return (
    <div className={`${CLAIM_ENGINE_CARD_CLASS} px-6 py-12 text-center`}>
      <p className="claim-engine-table-card__title text-sm">{title}</p>
      <p className="claim-engine-table-card__subtitle mx-auto mt-2 max-w-lg text-sm">{description}</p>
      {children ? <div className="claim-engine-meta mt-4 text-sm">{children}</div> : null}
      {(action || secondaryAction) ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
          {action ? (
            <Link href={action.href} className="claim-engine-link text-sm">
              {action.label}
            </Link>
          ) : null}
          {secondaryAction ? (
            <Link href={secondaryAction.href} className="claim-engine-link text-sm opacity-80">
              {secondaryAction.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
