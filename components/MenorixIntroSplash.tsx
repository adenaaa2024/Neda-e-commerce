"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Oswald } from "next/font/google";
import { LogoMark } from "@/components/LogoMark";
import { PlatformBrandingProvider } from "@/components/PlatformBrandingContext";
import "./menorix-intro.css";

const introDisplay = Oswald({
  subsets: ["latin"],
  weight: ["700"],
  display: "swap",
});

const LETTERS = ["M", "E", "N", "O", "R", "I", "X"] as const;

const ACRONYM_PARTS: { word: string; accentIndex: number }[] = [
  { word: "Merchant", accentIndex: 0 },
  { word: "Engine", accentIndex: 0 },
  { word: "for", accentIndex: -1 },
  { word: "Network", accentIndex: 0 },
  { word: "Optimization", accentIndex: 0 },
  { word: "&", accentIndex: -1 },
  { word: "Retail", accentIndex: 0 },
  { word: "Intelligence", accentIndex: 0 },
  { word: "eXchange", accentIndex: 1 },
];

function AcronymWord({ word, accentIndex, delayMs }: { word: string; accentIndex: number; delayMs: number }) {
  const accent = accentIndex >= 0 ? word[accentIndex] : null;
  const before = accent != null ? word.slice(0, accentIndex) : "";
  const after = accent != null ? word.slice(accentIndex + 1) : "";

  return (
    <span
      className={[
        "menorix-intro-acronym-word",
        accentIndex < 0 ? "menorix-intro-acronym-word--plain" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ ["--mx-word-delay" as string]: `${delayMs}ms` }}
    >
      {accent != null ? (
        <>
          {before ? <span className="menorix-intro-acronym-word__rest">{before}</span> : null}
          <span className="menorix-intro-acronym-word__accent">{accent}</span>
          {after ? <span className="menorix-intro-acronym-word__rest">{after}</span> : null}
        </>
      ) : (
        word
      )}
    </span>
  );
}

type MenorixIntroVariant = "login" | "admin" | "scanner";

type MenorixIntroSplashProps = {
  children: React.ReactNode;
  durationMs?: number;
  variant?: MenorixIntroVariant;
  /** Click anywhere on intro to skip straight to content */
  skippable?: boolean;
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

function IntroOverlay({
  durationMs,
  variant,
  skippable,
  onSkip,
}: {
  durationMs: number;
  variant: MenorixIntroVariant;
  skippable: boolean;
  onSkip: () => void;
}) {
  const [introExit, setIntroExit] = useState(false);
  const timers = useRef<number[]>([]);
  const isScanner = variant === "scanner";
  const isLogin = variant === "login";

  const sparkles = useMemo(
    () => buildSparkles(isScanner ? 12 : isLogin ? 32 : 18),
    [isLogin, isScanner],
  );
  const particles = useMemo(
    () => buildParticles(isScanner ? 0 : isLogin ? 40 : 22),
    [isLogin, isScanner],
  );

  const finish = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setIntroExit(true);
    window.setTimeout(onSkip, 520);
  }, [onSkip]);

  useEffect(() => {
    const exitAt = durationMs - 750;
    timers.current.push(window.setTimeout(() => setIntroExit(true), exitAt));
    timers.current.push(window.setTimeout(onSkip, durationMs));
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
  }, [durationMs, onSkip]);

  const letterClass = isScanner
    ? "menorix-intro-letter menorix-intro-letter--scanner"
    : isLogin
      ? "menorix-intro-letter menorix-intro-letter--login"
      : "menorix-intro-letter";
  const letterDelayBase = isScanner ? 80 : isLogin ? 260 : 120;
  const letterDelayStep = isScanner ? 120 : isLogin ? 200 : 280;
  const acronymWordDelayBase = letterDelayBase + LETTERS.length * letterDelayStep + 320;
  const acronymWordStep = isLogin ? 320 : 240;

  return (
    <button
      type="button"
      className={[
        "menorix-intro-overlay",
        isScanner ? "menorix-intro-overlay--scanner" : "",
        isLogin ? "menorix-intro-overlay--login" : "",
        skippable ? "menorix-intro-overlay--skippable" : "",
        introExit ? "menorix-intro-overlay--exit" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={skippable ? finish : undefined}
      aria-label={skippable ? "Skip intro" : undefined}
    >
      {!isScanner && !isLogin ? <div className="menorix-intro-court" aria-hidden /> : null}

      {!isScanner ? (
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
      ) : null}

      {isLogin || isScanner ? (
        <div
          className={[
            "menorix-intro-brand-stack",
            isLogin ? "menorix-intro-brand-stack--login" : "",
            isLogin ? introDisplay.className : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <LogoMark
            className={
              isScanner
                ? "menorix-intro-logo menorix-intro-logo--scanner"
                : "menorix-intro-logo menorix-intro-logo--login"
            }
          />
          <div className="menorix-intro-letters" aria-label="Menorix">
            {LETTERS.map((letter, i) => (
              <span
                key={letter}
                className={letterClass}
                style={{
                  ["--mx-letter-delay" as string]: `${letterDelayBase + i * letterDelayStep}ms`,
                  ["--mx-letter-tilt" as string]: `${i % 2 === 0 ? 12 : -12}deg`,
                  ["--mx-bounce-height" as string]: `${14 + (i % 3) * 6}px`,
                  ["--mx-shock-i" as string]: String(i),
                }}
              >
                {letter}
              </span>
            ))}
          </div>
          {isLogin ? (
            <div className="menorix-intro-acronym-sentence" aria-hidden>
              {ACRONYM_PARTS.map((part, i) => (
                <AcronymWord
                  key={`${part.word}-${i}`}
                  word={part.word}
                  accentIndex={part.accentIndex}
                  delayMs={acronymWordDelayBase + i * acronymWordStep}
                />
              ))}
            </div>
          ) : null}
          {isLogin ? <div className="menorix-intro-court menorix-intro-court--under-text" aria-hidden /> : null}
        </div>
      ) : (
        <div className="menorix-intro-letters" aria-label="Menorix">
          {LETTERS.map((letter, i) => (
            <span
              key={letter}
              className={letterClass}
              style={{
                ["--mx-letter-delay" as string]: `${letterDelayBase + i * letterDelayStep}ms`,
                ["--mx-letter-tilt" as string]: `${i % 2 === 0 ? 12 : -12}deg`,
                ["--mx-bounce-height" as string]: `${14 + (i % 3) * 6}px`,
              }}
            >
              {letter}
            </span>
          ))}
        </div>
      )}

      {!isScanner && particles.length > 0 ? (
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
      ) : null}
    </button>
  );
}

export function MenorixIntroSplash({
  children,
  durationMs = 6200,
  variant = "login",
  skippable = variant === "login" || variant === "scanner",
}: MenorixIntroSplashProps) {
  const [showIntro, setShowIntro] = useState(true);
  const [contentVisible, setContentVisible] = useState(false);

  const skip = useCallback(() => {
    setShowIntro(false);
    setContentVisible(true);
  }, []);

  useEffect(() => {
    if (!showIntro) return;
    const revealAt = Math.max(800, durationMs - 900);
    const revealTimer = window.setTimeout(() => setContentVisible(true), revealAt);
    return () => window.clearTimeout(revealTimer);
  }, [durationMs, showIntro]);

  const needsBranding = variant === "login" || variant === "scanner";

  const overlay = showIntro ? (
    needsBranding ? (
      <PlatformBrandingProvider>
        <IntroOverlay durationMs={durationMs} variant={variant} skippable={skippable} onSkip={skip} />
      </PlatformBrandingProvider>
    ) : (
      <IntroOverlay durationMs={durationMs} variant={variant} skippable={skippable} onSkip={skip} />
    )
  ) : null;

  return (
    <div className="menorix-intro-root">
      {overlay}
      <div className={["menorix-intro-content", contentVisible ? "menorix-intro-content--visible" : ""].join(" ")}>
        {children}
      </div>
    </div>
  );
}
