"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Oswald } from "next/font/google";
import { LogoMark } from "@/components/LogoMark";
import { PlatformBrandingProvider } from "@/components/PlatformBrandingContext";
import { hasSeenLoginIntro, markLoginIntroSeen } from "@/lib/login-intro-preference";
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

type MenorixIntroVariant = "login" | "admin" | "scanner";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function letterTiming(variant: MenorixIntroVariant) {
  const isScanner = variant === "scanner";
  const isLogin = variant === "login";
  return {
    isScanner,
    isLogin,
    letterDelayBase: isScanner ? 80 : isLogin ? 260 : 120,
    letterDelayStep: isScanner ? 120 : isLogin ? 200 : 280,
    acronymWordStep: isLogin ? 320 : 240,
  };
}

/** Extra time before parent watchdog forces overlay removal and form unlock. */
const INTRO_FAILSAFE_EXTRA_MS = 2500;

/** Login intro ends shortly after the last acronym word finishes animating. */
export function computeLoginIntroDurationMs(): number {
  const { letterDelayBase, letterDelayStep, acronymWordStep } = letterTiming("login");
  const acronymWordDelayBase = letterDelayBase + LETTERS.length * letterDelayStep + 320;
  const lastWordEnd =
    acronymWordDelayBase + (ACRONYM_PARTS.length - 1) * acronymWordStep + 560;
  return lastWordEnd + 1200;
}

function computeSafeRevealMs(variant: MenorixIntroVariant): number {
  const { isScanner, isLogin, letterDelayBase, letterDelayStep, acronymWordStep } =
    letterTiming(variant);
  const acronymWordDelayBase = letterDelayBase + LETTERS.length * letterDelayStep + 320;
  if (isLogin) {
    return acronymWordDelayBase + ACRONYM_PARTS.length * acronymWordStep + 640;
  }
  const lastLetterDelay = letterDelayBase + (LETTERS.length - 1) * letterDelayStep;
  return lastLetterDelay + (isScanner ? 480 : 1050) + 200;
}

function shouldPlayLoginIntro(): boolean {
  return !hasSeenLoginIntro();
}

type IntroErrorBoundaryProps = {
  children: React.ReactNode;
  onFail: () => void;
};

type IntroErrorBoundaryState = {
  failed: boolean;
};

/** If the overlay subtree throws, drop the overlay and leave login content visible. */
class IntroErrorBoundary extends React.Component<IntroErrorBoundaryProps, IntroErrorBoundaryState> {
  state: IntroErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): IntroErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFail();
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

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

type MenorixIntroSplashProps = {
  children: React.ReactNode;
  durationMs?: number;
  variant?: MenorixIntroVariant;
  /** Click anywhere on intro to skip straight to content */
  skippable?: boolean;
  /** Fires when intro completes or user skips */
  onFinished?: () => void;
  /** When true (login), skip intro on repeat visits via localStorage */
  rememberSkip?: boolean;
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

function IntroCourtGemLine({ underText = false }: { underText?: boolean }) {
  return (
    <div
      className={["menorix-intro-court", underText ? "menorix-intro-court--under-text" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-hidden
    >
      <span className="menorix-intro-court__track">
        <span className="menorix-intro-court__sweep" aria-hidden />
      </span>
      <span className="menorix-intro-court__gem" aria-hidden />
    </div>
  );
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
  const [safeReveal, setSafeReveal] = useState(false);
  const timers = useRef<number[]>([]);
  const { isScanner, isLogin, letterDelayBase, letterDelayStep, acronymWordStep } =
    letterTiming(variant);

  const sparkles = useMemo(
    () => buildSparkles(isScanner ? 18 : isLogin ? 32 : 18),
    [isLogin, isScanner],
  );
  const particles = useMemo(
    () => buildParticles(isScanner ? 14 : isLogin ? 40 : 22),
    [isLogin, isScanner],
  );

  const finish = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setIntroExit(true);
    window.setTimeout(onSkip, 520);
    window.setTimeout(onSkip, 1500);
  }, [onSkip]);

  useEffect(() => {
    const exitAt = durationMs - 750;
    const safeRevealAt = computeSafeRevealMs(variant);
    timers.current.push(window.setTimeout(() => setIntroExit(true), exitAt));
    timers.current.push(window.setTimeout(onSkip, durationMs));
    timers.current.push(window.setTimeout(() => setSafeReveal(true), safeRevealAt));
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
  }, [durationMs, onSkip, variant]);

  const letterClass = isScanner
    ? "menorix-intro-letter menorix-intro-letter--scanner"
    : isLogin
      ? "menorix-intro-letter menorix-intro-letter--login"
      : "menorix-intro-letter";
  const acronymWordDelayBase = letterDelayBase + LETTERS.length * letterDelayStep + 320;

  return (
    <button
      type="button"
      className={[
        "menorix-intro-overlay",
        isScanner ? "menorix-intro-overlay--scanner" : "",
        isLogin ? "menorix-intro-overlay--login" : "",
        skippable ? "menorix-intro-overlay--skippable" : "",
        introExit ? "menorix-intro-overlay--exit" : "",
        safeReveal ? "menorix-intro-overlay--safe-reveal" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={skippable ? finish : undefined}
      aria-label={skippable ? "Skip intro" : undefined}
    >
      {!isScanner && !isLogin ? <IntroCourtGemLine /> : null}

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
          {isLogin ? <IntroCourtGemLine underText /> : null}
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

      {particles.length > 0 ? (
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
  durationMs,
  variant = "login",
  skippable = variant === "login" || variant === "scanner",
  onFinished,
  rememberSkip = variant === "login",
}: MenorixIntroSplashProps) {
  const resolvedDuration =
    durationMs ?? (variant === "login" ? computeLoginIntroDurationMs() : 6200);

  /** Safe defaults: content visible, no overlay — works without JS or if hydration fails. */
  const [showIntro, setShowIntro] = useState(false);
  const [contentVisible, setContentVisible] = useState(true);

  const finishIntro = useCallback(() => {
    if (rememberSkip && variant === "login") {
      markLoginIntroSeen();
    }
    setShowIntro(false);
    setContentVisible(true);
    onFinished?.();
  }, [onFinished, rememberSkip, variant]);

  useLayoutEffect(() => {
    try {
      if (prefersReducedMotion()) {
        if (rememberSkip && variant === "login") {
          markLoginIntroSeen();
        }
        onFinished?.();
        return;
      }

      if (variant === "login" && rememberSkip && !shouldPlayLoginIntro()) {
        onFinished?.();
        return;
      }

      setShowIntro(true);
      setContentVisible(false);
    } catch {
      setShowIntro(false);
      setContentVisible(true);
      onFinished?.();
    }
  }, [onFinished, rememberSkip, variant]);

  useEffect(() => {
    if (!showIntro) return;

    const revealAt = Math.max(800, resolvedDuration - 900);
    const hardDeadline = resolvedDuration + INTRO_FAILSAFE_EXTRA_MS;

    const revealTimer = window.setTimeout(() => setContentVisible(true), revealAt);
    const contentUnlockTimer = window.setTimeout(() => setContentVisible(true), hardDeadline);
    const watchdogTimer = window.setTimeout(() => finishIntro(), hardDeadline);

    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(contentUnlockTimer);
      window.clearTimeout(watchdogTimer);
    };
  }, [finishIntro, resolvedDuration, showIntro]);

  const needsBranding = variant === "login" || variant === "scanner";

  const overlayInner = (
    <IntroOverlay
      durationMs={resolvedDuration}
      variant={variant}
      skippable={skippable}
      onSkip={finishIntro}
    />
  );

  const overlay = showIntro ? (
    <IntroErrorBoundary onFail={finishIntro}>
      {needsBranding ? (
        <PlatformBrandingProvider>{overlayInner}</PlatformBrandingProvider>
      ) : (
        overlayInner
      )}
    </IntroErrorBoundary>
  ) : null;

  return (
    <>
      <noscript>
        <style>{`.menorix-intro-root--playing .menorix-intro-content{opacity:1!important;transform:none!important}.menorix-intro-overlay{opacity:0!important;visibility:hidden!important;pointer-events:none!important}`}</style>
      </noscript>
      <div
        className={[
          "menorix-intro-root",
          showIntro ? "menorix-intro-root--playing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {overlay}
        <div
          className={[
            "menorix-intro-content",
            contentVisible ? "menorix-intro-content--visible" : "",
          ].join(" ")}
        >
          {children}
        </div>
      </div>
    </>
  );
}
