import { isUuidString } from "@/lib/uuid";

/** Surfaces that link into the operator product detail page — drives the back affordance. */
export type OperatorProductDetailFrom = "scan" | "package" | "pallet" | "returns";

export type OperatorProductDetailLinkOpts = {
  from?: OperatorProductDetailFrom;
  /** Optional context id (package id, pallet id, return item id) for future deep links. */
  fromId?: string;
};

export function parseOperatorProductDetailFrom(
  raw: string | null | undefined,
): OperatorProductDetailFrom | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "scan" || v === "package" || v === "pallet" || v === "returns") return v;
  return null;
}

/** Operator / returns surfaces — exact catalog product by `products.id` (not list). */
export function buildOperatorProductDetailHref(
  productId: string,
  opts?: OperatorProductDetailLinkOpts,
): string | null {
  const id = String(productId ?? "").trim();
  if (!isUuidString(id)) return null;
  const base = `/scanner/operator-mobile/products/${id}`;
  const from = opts?.from ? parseOperatorProductDetailFrom(opts.from) : null;
  const fromId = String(opts?.fromId ?? "").trim();
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (fromId && isUuidString(fromId)) qs.set("fromId", fromId);
  const q = qs.toString();
  return q ? `${base}?${q}` : base;
}

export function productLinkageHasDetailPage(linkage: {
  resolved_product_id?: string | null;
  identifier_resolution_status?: string | null;
}): boolean {
  const id = String(linkage.resolved_product_id ?? "").trim();
  if (!isUuidString(id)) return false;
  const st = String(linkage.identifier_resolution_status ?? "").trim().toLowerCase();
  return st === "resolved";
}

export function resolveOperatorProductDetailBackLink(
  fromRaw: string | null | undefined,
  _fromId?: string | null,
): { href: string; label: string } {
  const from = parseOperatorProductDetailFrom(fromRaw);
  switch (from) {
    case "returns":
      return { href: "/returns", label: "Back to returns" };
    case "package":
      return { href: "/returns", label: "Back to packages" };
    case "pallet":
      return { href: "/returns", label: "Back to pallets" };
    case "scan":
    default:
      return { href: "/scanner/operator-mobile/scan", label: "Back to scan" };
  }
}
