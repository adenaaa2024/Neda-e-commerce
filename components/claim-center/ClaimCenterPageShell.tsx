import type { ReactNode } from "react";

import { ClaimCenterHubNav } from "./ClaimCenterHubNav";
import { CLAIM_CENTER_PAGE_CLASS } from "./claim-center-ui";

export function ClaimCenterPageShell({
  title,
  description,
  children,
  showHub = false,
  banner,
}: {
  title: string;
  description: string;
  children: ReactNode;
  showHub?: boolean;
  banner?: ReactNode;
}) {
  return (
    <div className={CLAIM_CENTER_PAGE_CLASS}>
      {showHub ? <ClaimCenterHubNav /> : null}
      <header className="space-y-1 border-b pb-4">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        <p className="max-w-3xl text-sm opacity-80">{description}</p>
      </header>
      {banner}
      {children}
    </div>
  );
}
