/** Operator-mobile device eligibility — rugged scanners + mobile PWAs. */

export type OperatorDeviceSupport = {
  supported: boolean;
  reason: string | null;
  isMobileUa: boolean;
  isZebra: boolean;
  isAndroidWebView: boolean;
};

function readUa(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent;
}

export function isMobileUserAgent(): boolean {
  const ua = readUa();
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

export function isZebraDevice(): boolean {
  const ua = readUa();
  return /Zebra|TC\d{2,}|ET\d{2,}|MC\d{2,}/i.test(ua);
}

export function isAndroidWebView(): boolean {
  const ua = readUa();
  return /Android/i.test(ua) && /; wv\)|Version\/[\d.]+/i.test(ua);
}

export function evaluateOperatorDeviceSupport(opts?: {
  allowDesktop?: boolean;
}): OperatorDeviceSupport {
  const isMobileUa = isMobileUserAgent();
  const isZebra = isZebraDevice();
  const isWebView = isAndroidWebView();
  const allowDesktop = Boolean(opts?.allowDesktop);

  if (isMobileUa || isZebra || isWebView || allowDesktop) {
    return {
      supported: true,
      reason: null,
      isMobileUa,
      isZebra,
      isAndroidWebView: isWebView,
    };
  }

  return {
    supported: false,
    reason: "Menorix Mobile Scanner requires a supported mobile or rugged scanner device.",
    isMobileUa,
    isZebra,
    isAndroidWebView: isWebView,
  };
}
