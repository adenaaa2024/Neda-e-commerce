import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { fetchOperatorProductDetailAction } from "@/app/scanner/operator-mobile/_components/operator-store-actions";
import { buildOperatorProductDetailHref, resolveOperatorProductDetailBackLink } from "@/lib/scanner/operator-product-detail-path";
import { isUuidString } from "@/lib/uuid";

export default async function OperatorProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ from?: string; fromId?: string }>;
}) {
  const { productId } = await params;
  const sp = await searchParams;
  const id = String(productId ?? "").trim();
  const back = resolveOperatorProductDetailBackLink(sp.from, sp.fromId);

  if (!isUuidString(id)) {
    return (
      <main className="mx-auto min-h-screen max-w-lg px-4 py-8 text-slate-800 dark:text-slate-100">
        <p className="text-sm font-semibold text-rose-600">Invalid product id.</p>
        <Link href={back.href} className="mt-4 inline-flex text-sm font-semibold text-sky-600 underline">
          {back.label}
        </Link>
      </main>
    );
  }

  const res = await fetchOperatorProductDetailAction(id, null);

  if (!res.ok) {
    return (
      <main className="mx-auto min-h-screen max-w-lg px-4 py-8 text-slate-800 dark:text-slate-100">
        <Link href={back.href} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-sky-600">
          <ArrowLeft className="h-4 w-4" />
          {back.label}
        </Link>
        <h1 className="text-lg font-bold">Product not found</h1>
        <p className="mt-2 text-sm text-slate-500">{res.message}</p>
      </main>
    );
  }

  const p = res.product;
  const selfHref = buildOperatorProductDetailHref(p.id, { from: sp.from as "scan" | undefined, fromId: sp.fromId });

  return (
    <main className="mx-auto min-h-screen max-w-lg px-4 py-8 text-slate-800 dark:text-slate-100">
      <Link href={back.href} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-sky-600">
        <ArrowLeft className="h-4 w-4" />
        {back.label}
      </Link>
      <h1 className="text-xl font-bold tracking-tight">{p.product_name ?? "Catalog product"}</h1>
      <p className="mt-1 font-mono text-xs text-slate-500">{p.id}</p>
      <dl className="mt-6 space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">SKU</dt>
          <dd className="mt-0.5 font-mono font-semibold">{p.sku ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">FNSKU</dt>
          <dd className="mt-0.5 font-mono font-semibold">{p.fnsku ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">ASIN</dt>
          <dd className="mt-0.5 font-mono font-semibold">{p.asin ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">Barcode</dt>
          <dd className="mt-0.5 font-mono font-semibold">{p.barcode ?? "—"}</dd>
        </div>
        {selfHref ? (
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">Detail URL</dt>
            <dd className="mt-0.5 break-all font-mono text-[11px] text-slate-500">{selfHref}</dd>
          </div>
        ) : null}
      </dl>
    </main>
  );
}
