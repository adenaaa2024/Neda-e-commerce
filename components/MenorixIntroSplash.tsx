"use client";

import React, { useEffect, useMemo, useState } from "react";
import "./menorix-intro.css";

const LETTERS = ["M", "E", "N", "O", "R", "I", "X"] as const;

type MenorixIntroSplashProps = {
  children: React.ReactNode;
  /** Total intro length before content is fully visible */
  durationMs?: number;
  variant?: "login" | "scanner" | "admin";
};

function buildSparkles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    left: `${6 + ((i * 19) % 88)}%`,
    top: `${10 + ((i * 27) % 78)}%`,
    size: 3 + (i % 4),
    delay: 400 + (i % 9) * 140,
  }));
}

function buildParticles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: `${18 + ((i * 11) % 64)}%`,
    y: `${42 + ((i * 9) % 20)}%`,
    size: 2 + (i % 5),
    delay: 4200 + (i % 11) * 55,
    dx: `${-32 + (i % 64)}px`,
    dy: `${56 + (i % 72)}px`,
  }));
}

/**
 * Cinematic Menorix intro — letters drop & bounce like basketball, sparkles, powder, reveal.
 * Runs on every mount (refresh / navigation entry) — no session skip.
 */
export function MenorixIntroSplash({
  children,
  durationMs = 6200,
  variant = "login",
}: MenorixIntroSplashProps) {
  const [showIntro, setShowIntro] = useState(true);
  const [introExit, setIntroExit] = useState(false);
  const [contentVisible, setContentVisible] = useState(false);

  const sparkles = useMemo(
    () => buildSparkles(variant === "scanner" ? 24 : variant === "admin" ? 20 : 36),
    [variant],
  );
  const particles = useMemo(
    () => buildParticles(variant === "scanner" ? 32 : variant === "admin" ? 28 : 44),
    [variant],
  );

  useEffect(() => {
    const revealAt = Math.max(800, durationMs - 900);
    const exitAt = durationMs - 750;
    const hideAt = durationMs;

    const revealTimer = window.setTimeout(() => setContentVisible(true), revealAt);
    const exitTimer = window.setTimeout(() => setIntroExit(true), exitAt);
    const doneTimer = window.setTimeout(() => setShowIntro(false), hideAt);

    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(exitTimer);
      window.clearTimeout(doneTimer);
    };
  }, [durationMs]);

  return (
    <div className="menorix-intro-root">
      {showIntro ? (
        <div
          className={["menorix-intro-overlay", introExit ? "menorix-intro-overlay--exit" : ""].join(" ")}
          aria-hidden={introExit}
        >
          <div className="menorix-intro-court" aria-hidden />

          <div className="menorix-intro-sparkles" aria-hidden>
            {sparkles.map((s) => (
              <span
                key={s.id}
                className="menorix-intro-sparkle"
                style={{
                  left: s.left,
                  top: s.top,
                  ["--mx-sparkle-size" as string]: `${s.size}px`,
                  ["--mx-sparkle-delay" as string]: `${s.delay}ms`,
                }}
              />
            ))}
          </div>

          <div className="menorix-intro-letters" aria-label="Menorix">
            {LETTERS.map((letter, i) => (
              <span
                key={letter}
                className={["menorix-intro-letter", introExit ? "menorix-intro-letter--powder" : ""].join(" ")}
                style={{
                  ["--mx-letter-delay" as string]: `${120 + i * 380}ms`,
                  ["--mx-letter-tilt" as string]: `${i % 2 === 0 ? 14 : -14}deg`,
                  ["--mx-bounce-height" as string]: `${18 + (i % 3) * 8}px`,
                  ["--mx-powder-delay" as string]: `${4200 + i * 70}ms`,
                }}
              >
                {letter}
              </span>
            ))}
          </div>

          <p className="menorix-intro-wordmark">Menorix</p>

          <div className="menorix-intro-powder" aria-hidden>
            {particles.map((p) => (
              <span
                key={p.id}
                className="menorix-intro-particle"
                style={{
                  ["--mx-p-x" as string]: p.x,
                  ["--mx-p-y" as string]: p.y,
                  ["--mx-p-size" as string]: `${p.size}px`,
                  ["--mx-p-delay" as string]: `${p.delay}ms`,
                  ["--mx-p-dx" as string]: p.dx,
                  ["--mx-p-dy" as string]: p.dy,
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div
        className={[
          "menorix-intro-content",
          contentVisible ? "menorix-intro-content--visible" : "",
        ].join(" ")}
      >
        {children}
      </div>
    </div>
  );
}
