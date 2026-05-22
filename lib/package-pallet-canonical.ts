/**
 * Staging-canonical `packages` / `pallets` column names (Neda scanner linkage).
 * UI and server actions map reads/writes here — no legacy `package_number`, `photo_url`, or `photo_evidence` on packages.
 */

import {
  buildEntityPhotoEvidence,
  normalizeEntityPhotoEvidenceUrls,
} from "./entity-photo-evidence";

export const PACKAGE_LIST_SELECT =
  "id, organization_id, package_code, tracking_number, carrier_name, rma_number, " +
  "expected_item_count, actual_item_count, pallet_id, status, discrepancy_note, " +
  "store_id, order_id, created_at, updated_at, created_by, updated_by, " +
  "inside_photo_urls, outside_photo_urls, slip_photo_urls, " +
  "manifest_data, deleted_at, " +
  "stores(name,platform)";

export const PACKAGE_MUTATION_SELECT = PACKAGE_LIST_SELECT;

export const PALLET_LIST_SELECT =
  "id, organization_id, pallet_number, tracking_number, notes, status, item_count, " +
  "carrier_name, order_id, " +
  "created_at, updated_at, created_by, updated_by, store_id, " +
  "pallet_photo_urls, bol_photo_urls, shipping_label_urls, deleted_at, " +
  "stores(name,platform)";

export const PALLET_MUTATION_SELECT = PALLET_LIST_SELECT;

export function stringUrlArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
}

export function firstUrl(raw: unknown): string | null {
  const a = stringUrlArray(raw);
  return a[0] ?? null;
}

/** Claim / summary gallery order: opened, label, closed, outer, then extras. */
export function packageGalleryUrls(pkg: {
  inside_photo_urls?: unknown;
  outside_photo_urls?: unknown;
  slip_photo_urls?: unknown;
} | null | undefined): string[] {
  if (!pkg) return [];
  const inside = stringUrlArray(pkg.inside_photo_urls);
  const outside = stringUrlArray(pkg.outside_photo_urls);
  const slip = stringUrlArray(pkg.slip_photo_urls);
  const o = inside[0] ?? "";
  const l = outside[0] ?? "";
  const c = outside[1] ?? "";
  const u = outside[2] ?? "";
  const head = [o, l, c, u].filter(Boolean);
  return [...head, ...inside.slice(1), ...outside.slice(3), ...slip];
}

/** Pallet gallery: shipping label / manifest, BOL, overview — matches claim evidence slots. */
export function palletGalleryUrls(p: {
  shipping_label_urls?: unknown;
  bol_photo_urls?: unknown;
  pallet_photo_urls?: unknown;
} | null | undefined): string[] {
  if (!p) return [];
  const manifest = stringUrlArray(p.shipping_label_urls);
  const bol = stringUrlArray(p.bol_photo_urls);
  const overview = stringUrlArray(p.pallet_photo_urls);
  return [...manifest, ...bol, ...overview];
}

function structUrls(raw: unknown, key: string): string[] {
  if (!raw || typeof raw !== "object") return [];
  const v = (raw as Record<string, unknown>)[key];
  return stringUrlArray(v);
}

/** Maps wizard `photo_evidence` JSON + optional slip URL to staging array columns. */
export function packagePhotoArraysFromEvidence(
  photo_evidence: unknown,
  slipUrl?: string | null,
): {
  inside_photo_urls: string[] | null;
  outside_photo_urls: string[] | null;
  slip_photo_urls: string[] | null;
} {
  const inside = structUrls(photo_evidence, "inside_content_urls");
  const outside = [
    ...structUrls(photo_evidence, "label_urls"),
    ...structUrls(photo_evidence, "outer_box_urls"),
    ...structUrls(photo_evidence, "sealed_box_urls"),
  ];
  const flat = normalizeEntityPhotoEvidenceUrls(photo_evidence);
  const insideOut =
    inside.length > 0 ? inside : flat.length > 0 ? flat : [];
  const slip = slipUrl?.trim()
    ? [slipUrl.trim(), ...structUrls(photo_evidence, "slip_photo_urls")]
    : structUrls(photo_evidence, "slip_photo_urls");
  return {
    inside_photo_urls: insideOut.length ? insideOut : null,
    outside_photo_urls: outside.length ? outside : null,
    slip_photo_urls: slip.length ? [...new Set(slip)] : null,
  };
}

/** Edit drawer claim slots → array columns. */
export function packagePhotoArraysFromClaimSlots(
  opened: string,
  label: string,
  closed: string,
  existing?: {
    inside_photo_urls?: unknown;
    outside_photo_urls?: unknown;
    slip_photo_urls?: unknown;
  } | null,
): {
  inside_photo_urls?: string[];
  outside_photo_urls?: string[];
  slip_photo_urls?: string[];
} {
  const prevInside = stringUrlArray(existing?.inside_photo_urls);
  const prevOutside = stringUrlArray(existing?.outside_photo_urls);
  const prevSlip = stringUrlArray(existing?.slip_photo_urls);
  const inside = opened.trim()
    ? [opened.trim(), ...prevInside.slice(1)]
    : prevInside.length
      ? prevInside.slice(1)
      : [];
  const outsideHead: string[] = [];
  if (label.trim()) outsideHead.push(label.trim());
  if (closed.trim()) outsideHead.push(closed.trim());
  const outerTail = prevOutside.slice(2);
  const outside = [...outsideHead, ...outerTail];
  return {
    ...(inside.length ? { inside_photo_urls: inside } : {}),
    ...(outside.length ? { outside_photo_urls: outside } : {}),
    ...(prevSlip.length ? { slip_photo_urls: prevSlip } : {}),
  };
}

export function mergeSlipPhotoUrl(existing: unknown, url: string): string[] {
  const prev = stringUrlArray(existing);
  const u = url.trim();
  if (!u) return prev;
  if (prev.includes(u)) return prev;
  return [...prev, u];
}

export function palletPhotoArraysFromPayload(parts: {
  pallet_photo_urls?: string[] | string | null;
  bol_photo_urls?: string[] | string | null;
  shipping_label_urls?: string[] | string | null;
  /** Legacy single-URL keys from forms — coerced to one-element arrays. */
  photo_url?: string | null;
  bol_photo_url?: string | null;
  manifest_photo_url?: string | null;
}): {
  pallet_photo_urls: string[] | null;
  bol_photo_urls: string[] | null;
  shipping_label_urls: string[] | null;
} {
  const overview =
    parts.pallet_photo_urls != null
      ? stringUrlArray(parts.pallet_photo_urls)
      : parts.photo_url?.trim()
        ? [parts.photo_url.trim()]
        : [];
  const bol =
    parts.bol_photo_urls != null
      ? stringUrlArray(parts.bol_photo_urls)
      : parts.bol_photo_url?.trim()
        ? [parts.bol_photo_url.trim()]
        : [];
  const labels =
    parts.shipping_label_urls != null
      ? stringUrlArray(parts.shipping_label_urls)
      : parts.manifest_photo_url?.trim()
        ? [parts.manifest_photo_url.trim()]
        : [];
  return {
    pallet_photo_urls: overview.length ? overview : null,
    bol_photo_urls: bol.length ? bol : null,
    shipping_label_urls: labels.length ? labels : null,
  };
}

/** Strip legacy keys and map package insert/update payloads to DB row fields. */
export function mapPackageWriteRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...row };
  if ("package_number" in out && !("package_code" in out)) {
    out.package_code = String(out.package_number ?? "").trim();
    delete out.package_number;
  }
  if ("photo_evidence" in out || "manifest_photo_url" in out) {
    const arrays = packagePhotoArraysFromEvidence(
      out.photo_evidence,
      typeof out.manifest_photo_url === "string" ? out.manifest_photo_url : null,
    );
    if (arrays.inside_photo_urls) out.inside_photo_urls = arrays.inside_photo_urls;
    if (arrays.outside_photo_urls) out.outside_photo_urls = arrays.outside_photo_urls;
    if (arrays.slip_photo_urls) out.slip_photo_urls = arrays.slip_photo_urls;
    delete out.photo_evidence;
    delete out.manifest_photo_url;
  }
  for (const k of [
    "photo_url",
    "photo_return_label_url",
    "photo_opened_url",
    "photo_closed_url",
  ] as const) {
    delete out[k];
  }
  if ("inside_photo_urls" in out || "outside_photo_urls" in out || "slip_photo_urls" in out) {
    if ("inside_photo_urls" in out) {
      const a = stringUrlArray(out.inside_photo_urls);
      out.inside_photo_urls = a.length ? a : null;
    }
    if ("outside_photo_urls" in out) {
      const a = stringUrlArray(out.outside_photo_urls);
      out.outside_photo_urls = a.length ? a : null;
    }
    if ("slip_photo_urls" in out) {
      const a = stringUrlArray(out.slip_photo_urls);
      out.slip_photo_urls = a.length ? a : null;
    }
  }
  return out;
}

export function mapPalletWriteRow(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  delete out.photo_evidence;
  if (
    "photo_url" in out ||
    "bol_photo_url" in out ||
    "manifest_photo_url" in out ||
    "pallet_photo_urls" in out ||
    "bol_photo_urls" in out ||
    "shipping_label_urls" in out
  ) {
    const arrays = palletPhotoArraysFromPayload({
      pallet_photo_urls: out.pallet_photo_urls as string[] | undefined,
      bol_photo_urls: out.bol_photo_urls as string[] | undefined,
      shipping_label_urls: out.shipping_label_urls as string[] | undefined,
      photo_url: out.photo_url as string | null | undefined,
      bol_photo_url: out.bol_photo_url as string | null | undefined,
      manifest_photo_url: out.manifest_photo_url as string | null | undefined,
    });
    if (arrays.pallet_photo_urls) out.pallet_photo_urls = arrays.pallet_photo_urls;
    if (arrays.bol_photo_urls) out.bol_photo_urls = arrays.bol_photo_urls;
    if (arrays.shipping_label_urls) out.shipping_label_urls = arrays.shipping_label_urls;
    delete out.photo_url;
    delete out.bol_photo_url;
    delete out.manifest_photo_url;
  }
  return out;
}

export function normalizePackageRowFromDb(row: Record<string, unknown>): Record<string, unknown> {
  const code = String(row.package_code ?? row.package_number ?? "").trim();
  return {
    ...row,
    package_code: code,
    inside_photo_urls: stringUrlArray(row.inside_photo_urls),
    outside_photo_urls: stringUrlArray(row.outside_photo_urls),
    slip_photo_urls: stringUrlArray(row.slip_photo_urls),
  };
}

export function normalizePalletRowFromDb(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    pallet_photo_urls: stringUrlArray(row.pallet_photo_urls),
    bol_photo_urls: stringUrlArray(row.bol_photo_urls),
    shipping_label_urls: stringUrlArray(row.shipping_label_urls),
  };
}

/** @deprecated Use `packageGalleryUrls` — kept for claim-engine import sites during transition. */
export function packagePhotoEvidenceAsGallery(pkg: {
  photo_evidence?: unknown;
  inside_photo_urls?: unknown;
  outside_photo_urls?: unknown;
  slip_photo_urls?: unknown;
} | null | undefined): string[] {
  if (!pkg) return [];
  const fromArrays = packageGalleryUrls(pkg);
  if (fromArrays.length) return fromArrays;
  return normalizeEntityPhotoEvidenceUrls(pkg.photo_evidence);
}
