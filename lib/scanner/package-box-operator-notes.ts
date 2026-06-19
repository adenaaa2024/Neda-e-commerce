/** Operator box intake — separate editable operator notes from read-only system auto-notes. */

export const SYSTEM_AUTO_NOTE_EMPTY_BOX_PREFIX = "System Auto-Note: Empty box";
export const SYSTEM_AUTO_NOTE_DISCREPANCY_PREFIX = "System Auto-Note: Discrepancy found";

const LEGACY_DISCREPANCY_NOTE_PREFIX = "Discrepancy detected:";

function isSystemAutoNoteLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("System Auto-Note:")) return true;
  if (trimmed.startsWith(LEGACY_DISCREPANCY_NOTE_PREFIX)) return true;
  return false;
}

function systemNoteDedupeKey(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith(SYSTEM_AUTO_NOTE_EMPTY_BOX_PREFIX)) return "empty_box";
  if (trimmed.startsWith(SYSTEM_AUTO_NOTE_DISCREPANCY_PREFIX)) return "discrepancy";
  if (trimmed.toLowerCase().startsWith(LEGACY_DISCREPANCY_NOTE_PREFIX.toLowerCase())) {
    return "legacy_discrepancy";
  }
  return trimmed.toLowerCase();
}

/** De-dupe known system auto-note prefixes (empty box, discrepancy). */
export function dedupeSystemAutoNotes(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = String(raw ?? "").trim();
    if (!line) continue;
    const key = systemNoteDedupeKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function splitPackageBoxNotes(raw: string | null | undefined): {
  operatorNotes: string;
  systemNotes: string[];
} {
  const text = String(raw ?? "").trim();
  if (!text) return { operatorNotes: "", systemNotes: [] };

  const operatorLines: string[] = [];
  const systemNotes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (isSystemAutoNoteLine(line)) {
      systemNotes.push(line.trim());
    } else {
      operatorLines.push(line);
    }
  }

  return {
    operatorNotes: operatorLines.join("\n").trim(),
    systemNotes: dedupeSystemAutoNotes(systemNotes),
  };
}

/** Persist operator notes while preserving existing system auto-notes without duplication. */
export function mergePackageBoxNotesForPersist(
  operatorNotes: string,
  preservedSystemNotes: string[],
): string {
  const op = operatorNotes.trim();
  const system = dedupeSystemAutoNotes(
    preservedSystemNotes.map((s) => String(s ?? "").trim()).filter(Boolean),
  );
  if (system.length === 0) return op;
  if (!op) return system.join("\n");
  return `${op}\n${system.join("\n")}`;
}

export function formatSystemNoteForDisplay(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("System Auto-Note: ")) {
    return trimmed.slice("System Auto-Note: ".length);
  }
  return trimmed;
}

/** Manual operator discrepancy text — ignores read-only system auto-notes (historical shortage logs). */
export function packageOperatorNotesIndicateManualDiscrepancyHold(
  raw: string | null | undefined,
): boolean {
  const { operatorNotes } = splitPackageBoxNotes(raw);
  return operatorNotes.toLowerCase().includes("discrepancy");
}
