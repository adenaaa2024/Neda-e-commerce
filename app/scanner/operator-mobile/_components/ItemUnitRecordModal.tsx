"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { classifyProductBarcode } from "@/lib/product-barcode-classify";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { uploadMediaFileAction } from "@/lib/media-upload-actions";
import {
  ITEM_UNIT_DAMAGE_TAG_KEYS,
  ITEM_UNIT_SELLABLE_OK_TAG,
  type ItemUnitDiscrepancyTagKey,
  normalizeItemUnitDiscrepancySelection,
  packageItemRequiresEvidencePhotos,
  packageItemRequiresExpiryBlock,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import type { ProductLinkageDisplayContract } from "@/lib/scanner/product-linkage-display-contract";
import { OperatorProductLinkageMeta } from "@/app/scanner/operator-mobile/_components/OperatorProductLinkageMeta";
import { ProductLinkagePrimaryLink } from "@/app/scanner/operator-mobile/_components/ProductLinkagePrimaryLink";

const CHIP_LABEL: Record<ItemUnitDiscrepancyTagKey, string> = {
  damaged_product: "Damaged Product",
  scratched: "Scratched",
  wrong_item: "Wrong Item",
  expired: "Expired",
  missing_parts: "Missing Parts",
  missing_item: "Missing Item",
  sellable_ok: "Sellable/Ok",
};

export type ItemUnitRecordSavePayload = {
  scannedBarcode: string;
  discrepancyTags: ItemUnitDiscrepancyTagKey[];
  expiryDate: string | null;
  lotNumber: string | null;
  evidenceUrls: string[];
  traceabilityRequired: boolean;
  /** Optional item photo (not required for Sellable/Ok). */
  optionalItemPhotoUrl: string | null;
  /** Operator prose note on the unit (`return_items.notes`). */
  operatorNotes: string | null;
};

type ItemUnitRecordModalProps = {
  open: boolean;
  title?: string;
  subtitle?: string | null;
  initialBarcode: string;
  organizationId: string;
  slipDescription?: string | null;
  productLinkage?: ProductLinkageDisplayContract | null;
  storeId?: string | null;
  matchKind?: "fnsku" | "upc" | "unexpected" | null;
  resolveBarcodeLinkage?: (
    barcode: string,
    matchKind: "fnsku" | "upc" | "unexpected",
  ) => Promise<ProductLinkageDisplayContract | null>;
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
    storeId = null,
    matchKind = null,
    resolveBarcodeLinkage,
    busy,
    onClose,
    onSave,
  } = props;

  const [barcode, setBarcode] = useState("");
  const [liveLinkage, setLiveLinkage] = useState<ProductLinkageDisplayContract | null>(productLinkage);
  const [linkageResolving, setLinkageResolving] = useState(false);
  const [selectedTags, setSelectedTags] = useState<ItemUnitDiscrepancyTagKey[]>([ITEM_UNIT_SELLABLE_OK_TAG]);
  const [expiryDate, setExpiryDate] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [noExpiryChecked, setNoExpiryChecked] = useState(false);
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [optionalItemPhotoUrl, setOptionalItemPhotoUrl] = useState<string | null>(null);
  const [operatorNotes, setOperatorNotes] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [uploadingOptionalPhoto, setUploadingOptionalPhoto] = useState(false);
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  const optionalPhotoInputRef = useRef<HTMLInputElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const expiryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLiveLinkage(productLinkage);
  }, [productLinkage]);

  useEffect(() => {
    if (!open) return;
    setBarcode(initialBarcode.trim());
    setLiveLinkage(productLinkage);
    setSelectedTags([ITEM_UNIT_SELLABLE_OK_TAG]);
    setExpiryDate("");
    setLotNumber("");
    setNoExpiryChecked(false);
    setEvidenceUrls([]);
    setOptionalItemPhotoUrl(null);
    setOperatorNotes("");
    setLocalError(null);
    setLinkageResolving(false);
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
  }, [open, initialBarcode, productLinkage]);

  useEffect(() => {
    if (!open || !resolveBarcodeLinkage) return;
    const bc = barcode.trim();
    const sid = String(storeId ?? "").trim();
    if (!bc || bc.length < 3 || !sid) return;
    const mk: "fnsku" | "upc" | "unexpected" =
      matchKind === "fnsku" || matchKind === "upc" || matchKind === "unexpected" ? matchKind : "unexpected";
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLinkageResolving(true);
      void resolveBarcodeLinkage(bc, mk)
        .then((linkage) => {
          if (!cancelled) setLiveLinkage(linkage);
        })
        .finally(() => {
          if (!cancelled) setLinkageResolving(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, barcode, storeId, matchKind, resolveBarcodeLinkage]);

  const normalizedTags = useMemo(() => normalizeItemUnitDiscrepancySelection(selectedTags), [selectedTags]);
  const displayLinkage = liveLinkage ?? productLinkage;

  const categoryRequiresExpiry = useMemo(
    () =>
      packageItemRequiresExpiryBlock({
        tags: normalizedTags,
        slipDescription,
      }),
    [normalizedTags, slipDescription],
  );

  const traceabilityRequired = categoryRequiresExpiry && !noExpiryChecked;
  const needsEvidence = packageItemRequiresEvidencePhotos(normalizedTags);

  const focusExpiryAfterBarcodeCommit = useCallback(() => {
    if (!categoryRequiresExpiry || noExpiryChecked) return;
    window.setTimeout(() => {
      expiryInputRef.current?.focus({ preventScroll: true });
    }, 0);
  }, [categoryRequiresExpiry, noExpiryChecked]);

  const isConditionChipDisabled = useCallback(
    (key: ItemUnitDiscrepancyTagKey) => {
      if (busy) return true;
      if (selectedTags.includes("missing_item")) return key !== "missing_item";
      return false;
    },
    [busy, selectedTags],
  );

  const missingItemActive = selectedTags.includes("missing_item");

  const toggleTag = useCallback((key: ItemUnitDiscrepancyTagKey) => {
    if (busy) return;
    setLocalError(null);
    setSelectedTags((prev) => {
      if (prev.includes(key)) {
        if (key === "missing_item") return [ITEM_UNIT_SELLABLE_OK_TAG];
        const next = prev.filter((t) => t !== key);
        return next.length > 0 ? next : [ITEM_UNIT_SELLABLE_OK_TAG];
      }
      if (key === ITEM_UNIT_SELLABLE_OK_TAG) return [ITEM_UNIT_SELLABLE_OK_TAG];
      if (key === "missing_item") return ["missing_item"];
      const withoutExclusive = prev.filter((t) => t !== ITEM_UNIT_SELLABLE_OK_TAG && t !== "missing_item");
      return [...withoutExclusive, key];
    });
  }, [busy]);

  const uploadFiles = useCallback(
    async (files: FileList | null, mode: "evidence" | "optional") => {
      if (!files?.length) return;
      const oid = organizationId.trim();
      if (!oid) {
        setLocalError("Organization missing — cannot upload photos.");
        return;
      }
      const setUploading = mode === "evidence" ? setUploadingEvidence : setUploadingOptionalPhoto;
      setUploading(true);
      setLocalError(null);
      try {
        if (mode === "optional") {
          const file = files[0];
          if (!file) return;
          const fd = new FormData();
          fd.append("file", file);
          fd.append("bucket", "media");
          fd.append("folder", "packages");
          fd.append("organization_id", oid);
          const res = await uploadMediaFileAction(fd);
          if (!res.ok) {
            setLocalError(res.error);
            return;
          }
          setOptionalItemPhotoUrl(res.publicUrl);
        } else {
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
        }
      } finally {
        setUploading(false);
        if (mode === "evidence" && evidenceInputRef.current) evidenceInputRef.current.value = "";
        if (mode === "optional" && optionalPhotoInputRef.current) optionalPhotoInputRef.current.value = "";
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
    const tr = packageItemRequiresExpiryBlock({ tags, slipDescription }) && !noExpiryChecked;
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

    const gallery = [...evidenceUrls];
    if (optionalItemPhotoUrl) gallery.push(optionalItemPhotoUrl);

    await onSave({
      scannedBarcode: bc,
      discrepancyTags: tags,
      expiryDate: noExpiryChecked ? null : expiryDate.trim() || null,
      lotNumber: noExpiryChecked ? null : lotNumber.trim() || null,
      evidenceUrls: gallery,
      traceabilityRequired: tr,
      optionalItemPhotoUrl,
      operatorNotes: operatorNotes.trim() || null,
    });
  }, [
    barcode,
    selectedTags,
    needsEvidence,
    evidenceUrls,
    optionalItemPhotoUrl,
    operatorNotes,
    expiryDate,
    lotNumber,
    noExpiryChecked,
    onSave,
    slipDescription,
  ]);

  if (!open) return null;

  const BORDER = "rgba(148,163,184,0.25)";
  const CHIP_ACCENT = "var(--op-accent-gold, #d6b76e)";

  return (
    <div
      className="operator-shipment-flow-modal fixed inset-0 z-[200] flex items-end justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-unit-modal-title"
    >
      <div className="operator-item-unit-record-modal__shell flex max-h-[min(92vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border">
        <div className="operator-item-unit-record-modal__header flex shrink-0 items-start justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <p id="item-unit-modal-title" className="operator-item-unit-record-modal__title text-[17px] font-black">
              {title}
            </p>
            {subtitle ? (
              <p className="operator-item-unit-record-modal__subtitle mt-1 text-[12px] font-semibold leading-snug">
                {subtitle}
              </p>
            ) : null}
            {displayLinkage ? (
              <div className="mt-2">
                <ProductLinkagePrimaryLink
                  linkage={displayLinkage}
                  detailFrom="scan"
                  className="text-[12px] font-bold leading-snug text-sky-300 underline decoration-sky-400/60 underline-offset-2 hover:text-sky-200"
                />
                <OperatorProductLinkageMeta linkage={displayLinkage} linkResolvedProductId={false} detailFrom="scan" />
                {linkageResolving ? (
                  <p className="operator-item-unit-record-modal__muted mt-1 flex items-center gap-1 text-[10px] font-semibold">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Resolving product link…
                  </p>
                ) : null}
              </div>
            ) : linkageResolving ? (
              <p className="operator-item-unit-record-modal__muted mt-2 flex items-center gap-1 text-[10px] font-semibold">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Resolving product link…
              </p>
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
            <label className="operator-item-unit-record-modal__muted text-[11px] font-bold uppercase tracking-wide">
              Product barcode (UPC / FNSKU)
            </label>
            <input
              ref={barcodeInputRef}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onBlur={() => {
                const bc = barcode.trim();
                if (bc.length >= 3) focusExpiryAfterBarcodeCommit();
                if (!bc || !resolveBarcodeLinkage) return;
                const classified = classifyProductBarcode(bc);
                const mk: "fnsku" | "upc" | "unexpected" =
                  classified.kind === "fnsku" ? "fnsku" : classified.kind === "upc_ean" ? "upc" : "unexpected";
                setLinkageResolving(true);
                void resolveBarcodeLinkage(bc, mk)
                  .then((linkage) => setLiveLinkage(linkage))
                  .finally(() => setLinkageResolving(false));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const bc = barcode.trim();
                  if (bc.length >= 3 && categoryRequiresExpiry && !noExpiryChecked) {
                    focusExpiryAfterBarcodeCommit();
                    return;
                  }
                  void handleSave();
                }
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text").trim();
                if (!text || !resolveBarcodeLinkage) return;
                const classified = classifyProductBarcode(text);
                const mk: "fnsku" | "upc" | "unexpected" =
                  classified.kind === "fnsku" ? "fnsku" : classified.kind === "upc_ean" ? "upc" : "unexpected";
                window.setTimeout(() => {
                  setBarcode(text);
                  setLinkageResolving(true);
                  void resolveBarcodeLinkage(text, mk)
                    .then((linkage) => setLiveLinkage(linkage))
                    .finally(() => setLinkageResolving(false));
                }, 0);
              }}
              className="mt-2 h-[52px] w-full rounded-xl border-2 px-3 font-mono text-[15px] text-white outline-none transition duration-150 focus:border-cyan-300 focus:shadow-[0_0_0_3px_rgba(34,211,238,0.45),0_0_20px_rgba(45,212,191,0.3)] focus:ring-2 focus:ring-cyan-400/70"
              style={{ borderColor: "rgba(45,212,191,0.45)", backgroundColor: "#090E1A" }}
              placeholder="Scan or type ASIN / FNSKU / UPC / SKU…"
              autoComplete="off"
              autoFocus
              enterKeyHint="done"
            />
          </form>

          <div className="mt-4 border-t border-[#2A3038] pt-4">
            <label className="text-xs font-semibold text-[#9EA6AD] uppercase tracking-wider block mb-2">
              Expiration Date & Traceability
            </label>
            <div className="flex flex-col gap-3">
              <input
                ref={expiryInputRef}
                type="date"
                disabled={busy || noExpiryChecked}
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                aria-required={traceabilityRequired}
                className="w-full h-12 bg-[#171C22] border border-[#2A3038] rounded-xl px-4 text-[#FAF6ED] focus:outline-none focus:border-[#C8A96A] disabled:opacity-40 transition-all"
              />
              <label className="flex items-center gap-2.5 cursor-pointer text-sm text-[#FAF6ED] select-none mt-1">
                <input
                  type="checkbox"
                  checked={noExpiryChecked}
                  disabled={busy}
                  onChange={(e) => {
                    setNoExpiryChecked(e.target.checked);
                    if (e.target.checked) {
                      setExpiryDate("");
                      setLotNumber("");
                      setLocalError(null);
                    } else {
                      window.setTimeout(() => expiryInputRef.current?.focus({ preventScroll: true }), 0);
                    }
                  }}
                  className="w-4 h-4 rounded border-[#2A3038] bg-[#171C22] text-[#C8A96A] focus:ring-0"
                />
                <span>No expiration date on packaging</span>
              </label>
            </div>
            {categoryRequiresExpiry && !noExpiryChecked ? (
              <>
                <label className="operator-item-unit-record-modal__muted mt-4 block text-[10px] font-bold uppercase tracking-wide">
                  Batch / lot #
                </label>
                <input
                  value={lotNumber}
                  disabled={busy}
                  onChange={(e) => setLotNumber(e.target.value)}
                  className="mt-1.5 h-11 w-full rounded-lg border px-2 text-sm text-white outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: BORDER, backgroundColor: "#090E1A" }}
                  placeholder="Lot or batch code"
                />
                <p className="operator-item-unit-record-modal__muted mt-2 text-[10px] font-semibold leading-snug">
                  Required for food, cosmetics, and healthcare lines unless packaging has no expiry label.
                </p>
              </>
            ) : null}
          </div>

          <p className="mt-5 text-[12px] font-bold text-white">What is wrong with this item?</p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Item condition tags">
            {([...ITEM_UNIT_DAMAGE_TAG_KEYS, ITEM_UNIT_SELLABLE_OK_TAG] as const).map((key) => {
              const selected = selectedTags.includes(key);
              const disabled = isConditionChipDisabled(key);
              const lockedByMissingItem = missingItemActive && key !== "missing_item";
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleTag(key)}
                  className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed ${
                    lockedByMissingItem ? "opacity-50" : "disabled:opacity-40"
                  }`}
                  style={{
                    borderColor: selected ? CHIP_ACCENT : BORDER,
                    backgroundColor: selected ? "rgba(214, 183, 110, 0.14)" : "transparent",
                    color: selected ? CHIP_ACCENT : "inherit",
                  }}
                >
                  {CHIP_LABEL[key]}
                </button>
              );
            })}
          </div>

          <div className="mt-4">
            <p className="text-[11px] font-bold text-white/90">Optional item photo (optional)</p>
            <input
              ref={optionalPhotoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => void uploadFiles(e.target.files, "optional")}
            />
            <button
              type="button"
              disabled={busy || uploadingOptionalPhoto}
              onClick={() => optionalPhotoInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void uploadFiles(e.dataTransfer.files, "optional");
              }}
              className="mt-2 flex min-h-[52px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-2 py-2 text-[10px] font-semibold text-white/80 transition hover:bg-white/5 disabled:opacity-40"
              style={{ borderColor: "rgba(148,163,184,0.35)", backgroundColor: "rgba(9,14,26,0.65)" }}
            >
              {uploadingOptionalPhoto ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ImagePlus className="h-4 w-4 opacity-80" aria-hidden />
              )}
              {optionalItemPhotoUrl ? "Photo attached — tap to replace" : "Drop or tap to add optional photo"}
            </button>
          </div>

          {needsEvidence ? (
            <div className="mt-5">
              <p className="text-[12px] font-bold text-white">Issue evidence</p>
              <p className="operator-item-unit-record-modal__muted mt-1 text-[10px] font-semibold">
                Capture at least one photo that shows the specific problem before saving.
              </p>
              <input
                ref={evidenceInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="sr-only"
                onChange={(e) => void uploadFiles(e.target.files, "evidence")}
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
                <ul className="operator-item-unit-record-modal__muted mt-2 space-y-1 text-[10px] font-mono font-semibold">
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
            <p className="operator-item-unit-record-modal__local-error mt-4 rounded-lg border px-3 py-2 text-[12px] font-semibold">
              {localError}
            </p>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-[#2A3038] px-4 pt-3 pb-2">
          <label
            htmlFor="item-unit-operator-notes"
            className="text-xs font-semibold text-[#9EA6AD] uppercase tracking-wider block mb-2"
          >
            Operator Notes (Optional)
          </label>
          <textarea
            id="item-unit-operator-notes"
            value={operatorNotes}
            disabled={busy}
            onChange={(e) => setOperatorNotes(e.target.value)}
            rows={2}
            placeholder="Type any additional details or notes here..."
            className="w-full min-h-[72px] resize-y rounded-xl border px-4 py-3 text-sm text-[#FAF6ED] placeholder:text-[#9EA6AD]/70 focus:outline-none focus:border-[#C8A96A] disabled:opacity-40 transition-all"
            style={{ backgroundColor: "#171C22", borderColor: "#2A3038", borderWidth: 1 }}
          />
        </div>

        <div className="operator-item-unit-record-modal__header flex shrink-0 gap-3 border-t p-4">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="operator-shipment-flow-modal__btn-secondary h-12 flex-1 rounded-xl border text-sm font-bold transition active:scale-[0.98] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="item-unit-record-barcode-form"
            disabled={busy}
            className="operator-shipment-flow-modal__btn-primary flex h-12 flex-[1.2] items-center justify-center gap-2 rounded-xl border text-sm font-black transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} /> : null}
            Save unit
          </button>
        </div>
      </div>
    </div>
  );
}
