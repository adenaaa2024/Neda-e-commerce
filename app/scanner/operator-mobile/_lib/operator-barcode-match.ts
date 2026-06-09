import { buildOperatorBarcodeResolverFields } from "@/lib/scanner/operator-barcode-preview-input";

/** True when two scanned values resolve to the same product identifier (UPC/FNSKU/ASIN/SKU). */
export function operatorBarcodesMatchProduct(a: string, b: string): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  if (left.toLowerCase() === right.toLowerCase()) return true;

  const fa = buildOperatorBarcodeResolverFields(left);
  const fb = buildOperatorBarcodeResolverFields(right);
  if (fa.fnsku && fb.fnsku && fa.fnsku === fb.fnsku) return true;
  if (fa.upc && fb.upc && fa.upc === fb.upc) return true;
  if (fa.asin && fb.asin && fa.asin === fb.asin) return true;
  if (fa.sku && fb.sku && fa.sku === fb.sku) return true;
  return false;
}
