/**
 * Filing packet export path constants — dependency-free.
 *
 * Kept in its own module so that read-only composers (which run inside the
 * Next.js app build graph) can reference the local draft export location WITHOUT
 * importing `claim-filing-packet-export-pilot-v1.ts`, which dynamically loads
 * `playwright` for local PDF rendering. Pulling playwright into the App Router
 * bundle breaks the Turbopack build (it cannot process playwright's `.ttf`
 * recorder assets). This file must never import playwright or any runtime-heavy
 * dependency.
 */
export const PILOT_OUTPUT_ROOT =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1" as const;
