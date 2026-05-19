"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Camera, Loader2, X } from "lucide-react";
import { uploadMediaFileAction } from "@/lib/media-upload-actions";
import {
  ITEM_UNIT_DAMAGE_TAG_KEYS,
  ITEM_UNIT_SELLABLE_OK_TAG,
  type ItemUnitDiscrepancyTagKey,
  normalizeItemUnitDiscrepancySelection,
  packageItemDamageTagsSelected,
  packageItemRequiresEvidencePhotos,
  packageItemRequiresExpiryBlock,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import { productLinkagePrimaryLabel, type ProductLinkageDisplayContract } from "@/lib/scanner/product-linkage-display-contract";
import { OperatorProductLinkageMeta } from "@/app/scanner/operator-mobile/_components/OperatorProductLinkageMeta";

const CHIP_LABEL: Record<ItemUnitDiscrepancyTagKey, string> = {
  damaged_product: "Damaged Product",
  scratched: "Scratched",
  wrong_item: "Wrong Item",
  expired: "Expired",
  missing_parts: "Missing Parts",
  missing_item: "Missing Item",
  sellable_ok: "Sellable / OK",
};

export type ItemUnitRecordSavePayload = {
  scannedBarcode: string;
  discrepancyTags: ItemUnitDiscrepancyTagKey[];
  expiryDate: string | null;
  lotNumber: string | null;
  evidenceUrls: string[];
  traceabilityRequired: boolean;
};

type ItemUnitRecordModalProps = {
  open: boolean;
  title?: string;
  subtitle?: string | null;
  initialBarcode: string;
  organizationId: string;
  /** Packing-slip line description (perishable keyword heuristic). */
  slipDescription?: string | null;
  /** Server-built catalog linkage for the active slip line (when known). */
  productLinkage?: ProductLinkageDisplayContract | null;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: ItemUnitRecordSavePayload) => Promise<void>;
};

export function ItemUnitRecordModal(props: ItemUnitRecordModalProps) {
  const {
    open,
    title = "Record scanned unit",
    subtitle,
    initialBarcode,
    organizationId,
    slipDescription,
    productLinkage = null,
    busy,
    onClose,
    onSave,
  } = props;

  const [barcode, setBarcode] = useState("");
  const [selectedTags, setSelectedTags] = useState<ItemUnitDiscrepancyTagKey[]>([ITEM_UNIT_SELLABLE_OK_TAG]);
  const [expiryDate, setExpiryDate] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setBarcode(initialBarcode.trim());
    setSelectedTags([ITEM_UNIT_SELLABLE_OK_TAG]);
    setExpiryDate("");
    setLotNumber("");
    setEvidenceUrls([]);
    setLocalError(null);
    const focusBarcode = () => {
      const el = barcodeInputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      try {
        el.select();
      } catch {
        /* read-only inputs may reject select */
      }
    };
    focusBarcode();
    const t0 = window.setTimeout(focusBarcode, 0);
    const t1 = window.setTimeout(focusBarcode, 50);
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
    };
  }, [open, initialBarcode]);

  const normalizedTags = useMemo(() => normalizeItemUnitDiscrepancySelection(selectedTags), [selectedTags]);

  const traceabilityRequired = useMemo(
    () =>
      packageItemRequiresExpiryBlock({
        tags: normalizedTags,
        slipDescription,
      }),
    [normalizedTags, slipDescription],
  );

  const needsEvidence = packageItemRequiresEvidencePhotos(normalizedTags);

  const toggleTag = useCallback((key: ItemUnitDiscrepancyTagKey) => {
    setLocalError(null);
    if (key === ITEM_UNIT_SELLABLE_OK_TAG) {
      setSelectedTags([ITEM_UNIT_SELLABLE_OK_TAG]);
      return;
    }
    setSelectedTags((prev) => {
      const withoutOk = prev.filter((t) => t !== ITEM_UNIT_SELLABLE_OK_TAG);
      if (withoutOk.includes(key)) {
        const next = withoutOk.filter((t) => t !== key);
        return next.length ? next : [ITEM_UNIT_SELLABLE_OK_TAG];
      }
      return [...withoutOk, key];
    });
  }, []);

  const onEvidenceFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const oid = organizationId.trim();
      if (!oid) {
        setLocalError("Organization missing — cannot upload evidence.");
        return;
      }
      setUploadingEvidence(true);
      setLocalError(null);
      try {
        const nextUrls: string[] = [...evidenceUrls];
        for (const file of Array.from(files)) {
          if (nextUrls.length >= 12) break;
          const fd = new FormData();
          fd.append("file", file);
          fd.append("bucket", "media");
          fd.append("folder", "packages");
          fd.append("organization_id", oid);
          const res = await uploadMediaFileAction(fd);
          if (!res.ok) {
            setLocalError(res.error);
            break;
          }
          nextUrls.push(res.publicUrl);
        }
        setEvidenceUrls(nextUrls);
      } finally {
        setUploadingEvidence(false);
        if (evidenceInputRef.current) evidenceInputRef.current.value = "";
      }
    },
    [evidenceUrls, organizationId],
  );

  const handleSave = useCallback(async () => {
    setLocalError(null);
    const bc = barcode.trim();
    if (!bc) {
      setLocalError("Enter or confirm the product barcode.");
      return;
    }
    const tags = normalizeItemUnitDiscrepancySelection(selectedTags);
    if (tags.length === 0) {
      setLocalError("Select at least one condition.");
      return;
    }
    if (needsEvidence && evidenceUrls.length === 0) {
      setLocalError("Add at least one evidence photo for the selected issue(s).");
      return;
    }
    const tr = packageItemRequiresExpiryBlock({
      tags,
      slipDescription,
    });
    if (tr) {
      if (!expiryDate.trim()) {
        setLocalError("Expiration date is required for this item.");
        return;
      }
      if (!lotNumber.trim()) {
        setLocalError("Batch / lot # is required for this item.");
        return;
      }
    }

    await onSave({
      scannedBarcode: bc,
      discrepancyTags: tags,
      expiryDate: expiryDate.trim() || null,
      lotNumber: lotNumber.trim() || null,
      evidenceUrls,
      traceabilityRequired: tr,
    });
  }, [
    barcode,
    selectedTags,
    needsEvidence,
    evidenceUrls,
    expiryDate,
    lotNumber,
    onSave,
    slipDescription,
  ]);

  if (!open) return null;

  const CARD = "#0f172a";
  const BORDER = "rgba(148,163,184,0.25)";
  const MUTED = "rgba(148,163,184,0.92)";
  const TEAL = "#2dd4bf";

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/75 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-unit-modal-title"
    >
      <div
        className="flex max-h-[min(92vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border shadow-[0_0_40px_rgba(45,212,191,0.12)]"
        style={{ borderColor: "rgba(45,212,191,0.35)", backgroundColor: CARD }}
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b px-4 py-3" style={{ borderColor: BORDER }}>
          <div className="min-w-0">
            <p id="item-unit-modal-title" className="text-[17px] font-black text-white">
              {title}
            </p>
            {subtitle ? (
              <p className="mt-1 text-[12px] font-semibold leading-snug" style={{ color: MUTED }}>
                {subtitle}
              </p>
            ) : null}
            {productLinkage ? (
              <div className="mt-2">
                <p className="text-[12px] font-bold leading-snug text-white">
                  {productLinkagePrimaryLabel(productLinkage)}
                </p>
                <OperatorProductLinkageMeta linkage={productLinkage} />
              </div>
            ) : null}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-xl p-2 text-white/80 transition hover:bg-white/10 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <form
            id="item-unit-record-barcode-form"
            className="mb-1"
            noValidate
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <label className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
              Product barcode (UPC / FNSKU)
            </label>
            <input
              ref={barcodeInputRef}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              className="mt-2 h-[52px] w-full rounded-xl border-2 px-3 font-mono text-[15px] text-white outline-none transition duration-150 focus:border-cyan-300 focus:shadow-[0_0_0_3px_rgba(34,211,238,0.45),0_0_20px_rgba(45,212,191,0.3)] focus:ring-2 focus:ring-cyan-400/70"
              style={{ borderColor: "rgba(45,212,191,0.45)", backgroundColor: "#090E1A" }}
              placeholder="Scan or type…"
              autoComplete="off"
              autoFocus
              enterKeyHint="done"
            />
          </form>

          <p className="mt-5 text-[12px] font-bold text-white">What is wrong with this item?</p>
          <p className="mt-1 text-[10px] font-semibold leading-snug" style={{ color: MUTED }}>
            Select all that apply. Sellable / OK clears other issues. Box-level problems are set on BOX intake, not here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {([...ITEM_UNIT_DAMAGE_TAG_KEYS, ITEM_UNIT_SELLABLE_OK_TAG] as const).map((key) => {
              const selected = normalizedTags.includes(key);
              const disableDamageChips = normalizedTags.includes(ITEM_UNIT_SELLABLE_OK_TAG);
              const disableSellableOk = packageItemDamageTagsSelected(normalizedTags);
              const disabled =
                busy || (key !== ITEM_UNIT_SELLABLE_OK_TAG && disableDamageChips) || (key === ITEM_UNIT_SELLABLE_OK_TAG && disableSellableOk);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={Boolean(disabled) || busy}
                  onClick={() => toggleTag(key)}
                  className="rounded-full border px-3 py-1.5 text-[11px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35"
                  style={{
                    borderColor: selected ? TEAL : BORDER,
                    backgroundColor: selected ? "rgba(45,212,191,0.14)" : "#090E1A",
                    color: selected ? TEAL : "rgba(248,250,252,0.95)",
                  }}
                >
                  {CHIP_LABEL[key]}
                </button>
              );
            })}
          </div>

          {traceabilityRequired ? (
            <div className="mt-5 rounded-xl border p-3" style={{ borderColor: "rgba(251,191,36,0.4)", backgroundColor: "rgba(69,26,3,0.25)" }}>
              <p className="text-[12px] font-bold text-amber-100">Expiry &amp; batch (required)</p>
              <p className="mt-1 text-[10px] font-semibold text-amber-100/80">
                Required when <span className="font-bold">Expired</span> is selected or the line looks like grocery / perishables.
              </p>
              <label className="mt-3 block text-[10px] font-bold uppercase tracking-wide text-amber-50/90">Expiration date</label>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-lg border px-2 font-mono text-sm text-white outline-none"
                style={{ borderColor: BORDER, backgroundColor: "#090E1A" }}
              />
              <label className="mt-3 block text-[10px] font-bold uppercase tracking-wide text-amber-50/90">Batch / lot #</label>
              <input
                value={lotNumber}
                onChange={(e) => setLotNumber(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-lg border px-2 text-sm text-white outline-none"
                style={{ borderColor: BORDER, backgroundColor: "#090E1A" }}
                placeholder="Lot or batch code"
              />
            </div>
          ) : null}

          {needsEvidence ? (
            <div className="mt-5">
              <p className="text-[12px] font-bold text-white">Issue evidence</p>
              <p className="mt-1 text-[10px] font-semibold" style={{ color: MUTED }}>
                Capture at least one photo that shows the specific problem before saving.
              </p>
              <input
                ref={evidenceInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="sr-only"
                onChange={(e) => void onEvidenceFiles(e.target.files)}
              />
              <button
                type="button"
                disabled={busy || uploadingEvidence}
                onClick={() => evidenceInputRef.current?.click()}
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold text-white transition hover:bg-white/5 disabled:opacity-40"
                style={{ borderColor: "rgba(248,113,113,0.45)", backgroundColor: "rgba(127,29,29,0.2)" }}
              >
                {uploadingEvidence ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Camera className="h-5 w-5" strokeWidth={2} />
                )}
                Capture evidence photo
              </button>
              {evidenceUrls.length > 0 ? (
                <ul className="mt-2 space-y-1 text-[10px] font-mono font-semibold" style={{ color: MUTED }}>
                  {evidenceUrls.map((u) => (
                    <li key={u} className="truncate">
                      {u.slice(0, 72)}…
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] font-semibold text-red-300/90">No photos yet — required for this condition.</p>
              )}
            </div>
          ) : null}

          {localError ? (
            <p className="mt-4 rounded-lg border border-red-400/40 bg-red-950/40 px-3 py-2 text-[12px] font-semibold text-red-100">
              {localError}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-3 border-t p-4" style={{ borderColor: BORDER }}>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-12 flex-1 rounded-2xl border text-sm font-bold text-white transition hover:bg-white/5 disabled:opacity-40"
            style={{ borderColor: BORDER }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="item-unit-record-barcode-form"
            disabled={busy}
            className="flex h-12 flex-[1.2] items-center justify-center gap-2 rounded-2xl text-sm font-black text-[#042f2e] shadow-[0_6px_18px_rgba(45,212,191,0.28)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: `linear-gradient(180deg, ${TEAL} 0%, #14b8a6 100%)` }}
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} /> : null}
            Save unit
          </button>
        </div>
      </div>
    </div>
  );
}
