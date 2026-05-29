import { classifyProductBarcode } from "@/lib/product-barcode-classify";

export type OperatorBarcodePreviewMatchKind = "fnsku" | "upc" | "unexpected";

/** Maps a scanned/typed barcode to resolver fields (ASIN / FNSKU / UPC / SKU). */
export function buildOperatorBarcodeResolverFields(barcode: string): {
  matchKind: OperatorBarcodePreviewMatchKind;
  fnsku?: string;
  asin?: string;
  sku?: string;
  upc?: string;
} {
  const trimmed = String(barcode ?? "").trim();
  if (!trimmed) {
    return { matchKind: "unexpected" };
  }

  const classified = classifyProductBarcode(trimmed);
  if (classified.kind === "fnsku") {
    return { matchKind: "fnsku", fnsku: classified.normalized };
  }
  if (classified.kind === "asin") {
    return { matchKind: "unexpected", asin: classified.normalized };
  }
  if (classified.kind === "upc_ean") {
    return { matchKind: "upc", upc: classified.normalized };
  }
  if (classified.kind === "lpn") {
    return { matchKind: "unexpected", sku: classified.normalized };
  }
  return { matchKind: "unexpected", sku: classified.normalized };
}
