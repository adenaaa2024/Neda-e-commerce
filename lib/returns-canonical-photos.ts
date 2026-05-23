/**
 * Staging/live `packages` and `pallets` photo columns (Neda operator-mobile aligned).
 * Returns & Logistics UI may still use legacy scalar field names on records — map at read/write boundaries.
 */

function firstUrl(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return null;
}

function urlArray(values: unknown, max = 3): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Map DB row → legacy package photo fields used by Returns UI. */
export function packageLegacyPhotosFromRow(row: Record<string, unknown>): {
  outside_photo_urls: string[];
  inside_photo_urls: string[];
  slip_photo_urls: string[];
  photo_url: string | null;
  photo_opened_url: string | null;
  photo_return_label_url: string | null;
  photo_closed_url: string | null;
  manifest_photo_url: string | null;
} {
  const outside = urlArray(row.outside_photo_urls);
  const inside = urlArray(row.inside_photo_urls);
  const slip = urlArray(row.slip_photo_urls);
  const manifestUrl = String(row.manifest_url ?? "").trim() || null;
  return {
    outside_photo_urls: outside,
    inside_photo_urls: inside,
    slip_photo_urls: slip,
    photo_url: (firstUrl(outside) ?? String(row.photo_url ?? "").trim()) || null,
    photo_opened_url: (firstUrl(inside) ?? String(row.photo_opened_url ?? "").trim()) || null,
    photo_return_label_url: (firstUrl(slip) ?? String(row.photo_return_label_url ?? "").trim()) || null,
    photo_closed_url: (outside[1] ?? String(row.photo_closed_url ?? "").trim()) || null,
    manifest_photo_url: (firstUrl(slip) ?? manifestUrl ?? String(row.manifest_photo_url ?? "").trim()) || null,
  };
}

/** Map legacy package photo writes → canonical array columns (omit keys when unchanged). */
export function packageCanonicalPhotoPatch(
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const patch = { ...updates };
  const setOutside = (urls: string[]) => {
    patch.outside_photo_urls = urls;
  };
  const setInside = (urls: string[]) => {
    patch.inside_photo_urls = urls;
  };
  const setSlip = (urls: string[]) => {
    patch.slip_photo_urls = urls;
  };

  if (patch.photo_url !== undefined) {
    const u = String(patch.photo_url ?? "").trim();
    const prev = urlArray(patch.outside_photo_urls);
    setOutside(u ? [u, ...prev.slice(1)] : prev.length ? prev.slice(1) : []);
    delete patch.photo_url;
  }
  if (patch.photo_opened_url !== undefined) {
    const u = String(patch.photo_opened_url ?? "").trim();
    setInside(u ? [u] : []);
    delete patch.photo_opened_url;
  }
  if (patch.photo_return_label_url !== undefined) {
    const u = String(patch.photo_return_label_url ?? "").trim();
    setSlip(u ? [u] : []);
    delete patch.photo_return_label_url;
  }
  if (patch.photo_closed_url !== undefined) {
    const u = String(patch.photo_closed_url ?? "").trim();
    const prev = urlArray(patch.outside_photo_urls);
    const first = prev[0] ?? "";
    setOutside([first, u].filter(Boolean));
    delete patch.photo_closed_url;
  }
  if (patch.manifest_photo_url !== undefined) {
    const u = String(patch.manifest_photo_url ?? "").trim();
    if (u) {
      patch.manifest_url = u;
      const prevSlip = urlArray(patch.slip_photo_urls);
      setSlip([u, ...prevSlip.filter((x) => x !== u)].slice(0, 3));
    }
    delete patch.manifest_photo_url;
  }
  delete patch.photo_evidence;
  return patch;
}

/** Map DB row → legacy pallet photo fields used by Returns UI. */
export function palletLegacyPhotosFromRow(row: Record<string, unknown>): {
  pallet_photo_urls: string[];
  bol_photo_urls: string[];
  shipping_label_urls: string[];
  photo_url: string | null;
  bol_photo_url: string | null;
  manifest_photo_url: string | null;
} {
  const pallet = urlArray(row.pallet_photo_urls);
  const bol = urlArray(row.bol_photo_urls);
  const labels = urlArray(row.shipping_label_urls);
  return {
    pallet_photo_urls: pallet,
    bol_photo_urls: bol,
    shipping_label_urls: labels,
    photo_url: (firstUrl(pallet) ?? String(row.photo_url ?? "").trim()) || null,
    bol_photo_url: (firstUrl(bol) ?? String(row.bol_photo_url ?? "").trim()) || null,
    manifest_photo_url: (firstUrl(labels) ?? String(row.manifest_photo_url ?? "").trim()) || null,
  };
}

/** Map legacy pallet photo writes → canonical array columns. */
export function palletCanonicalPhotoPatch(
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const patch = { ...updates };

  if (patch.photo_url !== undefined) {
    const u = String(patch.photo_url ?? "").trim();
    patch.pallet_photo_urls = u ? [u] : [];
    delete patch.photo_url;
  }
  if (patch.bol_photo_url !== undefined) {
    const u = String(patch.bol_photo_url ?? "").trim();
    patch.bol_photo_urls = u ? [u] : [];
    delete patch.bol_photo_url;
  }
  if (patch.manifest_photo_url !== undefined) {
    const u = String(patch.manifest_photo_url ?? "").trim();
    patch.shipping_label_urls = u ? [u] : [];
    delete patch.manifest_photo_url;
  }
  if (patch.pallet_photo_urls !== undefined) {
    patch.pallet_photo_urls = urlArray(patch.pallet_photo_urls);
  }
  if (patch.bol_photo_urls !== undefined) {
    patch.bol_photo_urls = urlArray(patch.bol_photo_urls);
  }
  if (patch.shipping_label_urls !== undefined) {
    patch.shipping_label_urls = urlArray(patch.shipping_label_urls);
  }
  delete patch.photo_evidence;
  return patch;
}
