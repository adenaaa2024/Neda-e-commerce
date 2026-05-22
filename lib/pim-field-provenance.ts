/**
 * Field provenance may live on `products.field_provenance` (newer DBs) or under
 * `metadata.pim_field_provenance` when the column is absent — read-only helpers.
 */

export function getPimFieldProvenanceObject(product: Record<string, unknown>): Record<string, unknown> | null {
  const direct = product.field_provenance;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const o = direct as unknown as Record<string, unknown>;
    if (Object.keys(o).length) return o;
  }
  const meta = product.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const m = meta as unknown as Record<string, unknown>;
    const fp = m.pim_field_provenance;
    if (fp && typeof fp === "object" && !Array.isArray(fp)) {
      const o = fp as unknown as Record<string, unknown>;
      if (Object.keys(o).length) return o;
    }
  }
  return null;
}
