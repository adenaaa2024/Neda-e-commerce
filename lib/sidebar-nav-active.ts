import { normalizeAppPath } from "./claims-hub-routes";

/** Path portion of a sidebar href (ignores query/hash for route matching). */
export function sidebarHrefPath(href: string): string {
  return href.split("?")[0]?.split("#")[0] ?? href;
}

/** True when the current route equals or descends from the sidebar href path. */
export function sidebarHrefMatchesPath(href: string, path: string): boolean {
  const hrefPath = sidebarHrefPath(href);
  return path === hrefPath || path.startsWith(`${hrefPath}/`);
}

/**
 * Pick the single best-matching sidebar leaf for the current route:
 * exact path match first, otherwise the longest matching href prefix.
 */
export function resolveBestMatchingSidebarHref(
  pathname: string,
  candidateHrefs: readonly string[],
): string | null {
  const path = normalizeAppPath(pathname);
  const matches = candidateHrefs.filter((href) => sidebarHrefMatchesPath(href, path));
  if (matches.length === 0) return null;

  const exact = matches.find((href) => sidebarHrefPath(href) === path);
  if (exact) return exact;

  return matches.reduce((best, href) =>
    sidebarHrefPath(href).length > sidebarHrefPath(best).length ? href : best,
  );
}
