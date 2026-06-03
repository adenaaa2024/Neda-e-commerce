/** Service-worker update availability for installed Menorix PWA. */

type SwUpdateListener = (available: boolean) => void;

let updateAvailable = false;
const listeners = new Set<SwUpdateListener>();

function notify() {
  listeners.forEach((fn) => fn(updateAvailable));
}

export function setSwUpdateAvailable(available: boolean): void {
  if (updateAvailable === available) return;
  updateAvailable = available;
  notify();
}

export function isSwUpdateAvailable(): boolean {
  return updateAvailable;
}

export function subscribeSwUpdate(listener: SwUpdateListener): () => void {
  listeners.add(listener);
  listener(updateAvailable);
  return () => listeners.delete(listener);
}

/** Activate waiting worker and reload — used by the update banner. */
export async function applyWaitingServiceWorkerUpdate(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const waiting = registration?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  await new Promise<void>((resolve) => {
    const onControllerChange = () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    waiting.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(resolve, 4000);
  });
  window.location.reload();
}
