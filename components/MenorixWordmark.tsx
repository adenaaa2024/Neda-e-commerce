"use client";

import type { CSSProperties } from "react";
import { Montserrat } from "next/font/google";
import "./menorix-wordmark.css";

const wordmarkFont = Montserrat({
  subsets: ["latin"],
  weight: ["800"],
  display: "swap",
});

type MenorixWordmarkSize = "login" | "intro" | "sidebar" | "mobile-header" | "compact";

type MenorixWordmarkProps = {
  className?: string;
  /** Context-specific scale — typography stays identical. */
  size?: MenorixWordmarkSize;
  animated?: boolean;
};

export type { MenorixWordmarkSize };

const WORDMARK_GLYPHS: { kind: "letter" | "e" | "x"; char?: string; tilt: number }[] = [
  { kind: "letter", char: "M", tilt: 4 },
  { kind: "e", tilt: -3 },
  { kind: "letter", char: "N", tilt: 5 },
  { kind: "letter", char: "O", tilt: -4 },
  { kind: "letter", char: "R", tilt: 3 },
  { kind: "letter", char: "I", tilt: -5 },
  { kind: "x", tilt: 6 },
];

function glyphMotionStyle(index: number, tilt: number): CSSProperties {
  return {
    ["--mx-wm-i" as string]: String(index),
    ["--mx-wm-tilt" as string]: `${tilt}deg`,
  };
}

/** Brand wordmark — matches logo: M/N/O/R/I solid, E = 3 gold bars, X = gold gradient. */
export function MenorixWordmark({
  className,
  size = "login",
  animated = false,
}: MenorixWordmarkProps) {
  const glyphClass = animated ? "menorix-wordmark__glyph" : "";

  return (
    <span
      className={[
        "menorix-wordmark",
        `menorix-wordmark--${size}`,
        animated ? "menorix-wordmark--live" : "",
        wordmarkFont.className,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Menorix"
      role="img"
    >
      {WORDMARK_GLYPHS.map((g, i) => {
        const motion = animated ? glyphMotionStyle(i, g.tilt) : undefined;
        if (g.kind === "letter") {
          return (
            <span key={`${g.char}-${i}`} className={["menorix-wordmark__letter", glyphClass].filter(Boolean).join(" ")} style={motion}>
              {g.char}
            </span>
          );
        }
        if (g.kind === "e") {
          return (
            <span key="e" className={["menorix-wordmark__e", glyphClass].filter(Boolean).join(" ")} aria-hidden style={motion}>
              <span className="menorix-wordmark__e-bar" />
              <span className="menorix-wordmark__e-bar" />
              <span className="menorix-wordmark__e-bar" />
            </span>
          );
        }
        return (
          <span key="x" className={["menorix-wordmark__x", glyphClass].filter(Boolean).join(" ")} style={motion}>
            X
          </span>
        );
      })}
    </span>
  );
}
