import type { ReactNode } from "react";

export function MenorixModuleCommandHome({
  title,
  subtitle,
  kpis,
  tiles,
  sidePanels,
}: {
  title: string;
  subtitle: string;
  kpis: ReactNode;
  tiles: ReactNode;
  sidePanels?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        <p className="max-w-3xl text-sm opacity-80">{subtitle}</p>
      </header>
      {kpis}
      <div className="grid gap-6 xl:grid-cols-[1fr_minmax(280px,340px)]">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">Quick actions</h2>
          {tiles}
        </section>
        {sidePanels ? <aside className="space-y-4">{sidePanels}</aside> : null}
      </div>
    </div>
  );
}
