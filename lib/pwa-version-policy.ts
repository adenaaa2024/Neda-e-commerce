/** Semver-ish compare for Menorix PWA version enforcement (major.minor.patch). */

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseAppVersion(version: string): ParsedSemver | null {
  const raw = String(version ?? "").trim();
  const match = SEMVER_RE.exec(raw);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    raw,
  };
}

export function compareAppVersions(a: string, b: string): number | null {
  const left = parseAppVersion(a);
  const right = parseAppVersion(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function isVersionBelow(current: string, minimum: string): boolean {
  const cmp = compareAppVersions(current, minimum);
  if (cmp == null) return false;
  return cmp < 0;
}

export function isVersionAtLeast(current: string, minimum: string): boolean {
  const cmp = compareAppVersions(current, minimum);
  if (cmp == null) return true;
  return cmp >= 0;
}
