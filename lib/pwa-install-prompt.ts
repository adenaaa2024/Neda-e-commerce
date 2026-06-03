/** Captured Chrome/Edge `beforeinstallprompt` for the scanner PWA install banner. */

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

/** Call once on app boot (client layout). */
export function initPwaInstallPromptCapture(): void {
  if (typeof window === "undefined") return;
  if ((window as Window & { __mxPwaPromptInit?: boolean }).__mxPwaPromptInit) return;
  (window as Window & { __mxPwaPromptInit?: boolean }).__mxPwaPromptInit = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function runDeferredInstallPrompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = deferredPrompt;
  if (!prompt) return "unavailable";
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === "accepted") deferredPrompt = null;
  return choice.outcome;
}
