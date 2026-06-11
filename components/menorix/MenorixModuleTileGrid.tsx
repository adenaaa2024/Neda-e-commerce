import type { ReactNode } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";

import {
  MENORIX_MODULE_TILE_CLASS,
  MENORIX_MODULE_TILE_GRID,
  menorixModuleBadgeTone,
} from "./menorix-module-ui";

export type MenorixModuleTile = {
  id: string;
  title: string;
  description: string;
  href: string;
  count?: number | string | null;
  urgency?: "low" | "medium" | "high" | null;
  locked?: boolean;
  nextAction?: string;
  icon?: ReactNode;
};

function urgencyTone(u: MenorixModuleTile["urgency"]): string {
  if (u === "high") return "danger";
  if (u === "medium") return "warning";
  return "neutral";
}

export function MenorixModuleTileGrid({ tiles }: { tiles: MenorixModuleTile[] }) {
  return (
    <div className={MENORIX_MODULE_TILE_GRID}>
      {tiles.map((tile) => {
        const content = (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {tile.icon ? <span className="opacity-70">{tile.icon}</span> : null}
                <h3 className="text-sm font-semibold">{tile.title}</h3>
              </div>
              {tile.locked ? (
                <Lock className="h-4 w-4 shrink-0 opacity-50" aria-label="Locked" />
              ) : tile.count != null && tile.count !== "" ? (
                <span className="text-lg font-bold tabular-nums">{tile.count}</span>
              ) : null}
            </div>
            <p className="mt-2 text-xs opacity-70">{tile.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {tile.urgency ? (
                <span className={menorixModuleBadgeTone(urgencyTone(tile.urgency))}>
                  {tile.urgency === "high" ? "Urgent" : tile.urgency === "medium" ? "Attention" : "Normal"}
                </span>
              ) : null}
              {tile.locked ? (
                <span className={menorixModuleBadgeTone("neutral")}>Locked</span>
              ) : tile.nextAction ? (
                <span className="text-[11px] font-medium opacity-80">{tile.nextAction}</span>
              ) : null}
            </div>
          </>
        );

        if (tile.locked) {
          return (
            <div key={tile.id} className={`${MENORIX_MODULE_TILE_CLASS} cursor-not-allowed opacity-60`} aria-disabled>
              {content}
            </div>
          );
        }

        return (
          <Link key={tile.id} href={tile.href} className={MENORIX_MODULE_TILE_CLASS}>
            {content}
          </Link>
        );
      })}
    </div>
  );
}
