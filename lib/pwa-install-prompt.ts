/** Captured Chrome/Edge `beforeinstallprompt` for the Menorix PWA install banner. */

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __mxDeferredInstallPrompt?: BeforeInstallPromptEvent;
    __mxPwaPromptInit?: boolean;
    __mxPwaEarlyCapture?: boolean;
  }
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

function syncFromWindow() {
  const early = window.__mxDeferredInstallPrompt ?? null;
  if (early !== deferredPrompt) {
    deferredPrompt = early;
    notify();
  }
}

/** Call once on app boot (client layout). */
export function initPwaInstallPromptCapture(): void {
  if (typeof window === "undefined") return;

  syncFromWindow();

  if (window.__mxPwaPromptInit) return;
  window.__mxPwaPromptInit = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    window.__mxDeferredInstallPrompt = deferredPrompt;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    window.__mxDeferredInstallPrompt = undefined;
    notify();
  });

  window.addEventListener("mx-pwa-install-ready", syncFromWindow);
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  if (typeof window !== "undefined" && window.__mxDeferredInstallPrompt) {
    return window.__mxDeferredInstallPrompt;
  }
  return deferredPrompt;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function runDeferredInstallPrompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = getDeferredInstallPrompt();
  if (!prompt) return "unavailable";
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === "accepted") {
    deferredPrompt = null;
    window.__mxDeferredInstallPrompt = undefined;
  }
  return choice.outcome;
}
