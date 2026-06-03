"use client";

import { Montserrat } from "next/font/google";
import "./menorix-wordmark.css";

const wordmarkFont = Montserrat({
  subsets: ["latin"],
  weight: ["800"],
  display: "swap",
});

type MenorixWordmarkProps = {
  className?: string;
  /** login = slightly below logo size; intro = loading splash */
  size?: "login" | "intro";
  animated?: boolean;
};

/** Brand wordmark — matches logo: M/N/O/R/I solid, E = 3 gold bars, X = gold gradient. */
export function MenorixWordmark({
  className,
  size = "login",
  animated = false,
}: MenorixWordmarkProps) {
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
      <span className="menorix-wordmark__letter">M</span>
      <span className="menorix-wordmark__e" aria-hidden>
        <span className="menorix-wordmark__e-bar" />
        <span className="menorix-wordmark__e-bar" />
        <span className="menorix-wordmark__e-bar" />
      </span>
      <span className="menorix-wordmark__letter">N</span>
      <span className="menorix-wordmark__letter">O</span>
      <span className="menorix-wordmark__letter">R</span>
      <span className="menorix-wordmark__letter">I</span>
      <span className="menorix-wordmark__x">X</span>
    </span>
  );
}
