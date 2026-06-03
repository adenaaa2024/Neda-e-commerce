"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { classifyProductBarcode } from "@/lib/product-barcode-classify";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";
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
import { ScannerPhotoActionSheet } from "@/app/scanner/operator-mobile/_components/ScannerPhotoActionSheet";

const CHIP_LABEL: Record<ItemUnitDiscrepancyTagKey, string> = {
  damaged_product: "Damaged Product",
  scratched: "Scratched",
  wrong_item: "Wrong Item",
  expired: "Expired",
  missing_parts: "Missing Parts",
  missing_item: "Missing Item",
  sellable_ok: "Sellable/Ok",
};

const VALIDATION_ISSUE_TITLE = {
  EXPIRATION_DATE: "Expiration date required",
  EVIDENCE: "Evidence photo required",
} as const;

type ItemUnitValidationTarget = "barcode" | "condition" | "expiration" | "evidence" | "allocation";

export type ItemUnitValidationIssue = {
  code: string;
  title: string;
  message: string;
  target: ItemUnitValidationTarget;
};

export type ItemUnitRecordSaveResult = { ok: true } | { ok: false; message: string };

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

type ItemUnitPhotoMenuTarget = "optional" | "evidence";

function validateItemUnitBeforeSave(input: {
  barcode: string;
  tags: ItemUnitDiscrepancyTagKey[];
  hasExpiredTag: boolean;
  noExpiryChecked: boolean;
  expiryDate: string;
  traceabilityRequired: boolean;
  needsEvidence: boolean;
  evidenceCount: number;
}): ItemUnitValidationIssue[] {
  const issues: ItemUnitValidationIssue[] = [];
  const bc = input.barcode.trim();
  if (!bc) {
    issues.push({
      code: "barcode",
      title: "Barcode required",
      message: "Enter or confirm the product barcode.",
      target: "barcode",
    });
  }
  if (input.tags.length === 0) {
    issues.push({
      code: "condition",
      title: "Condition required",
      message: "Select at least one condition.",
      target: "condition",
    });
  }
  if (input.hasExpiredTag && !input.noExpiryChecked && !input.expiryDate.trim()) {
    issues.push({
      code: "expiration_date",
      title: VALIDATION_ISSUE_TITLE.EXPIRATION_DATE,
      message: "Enter the expiration date or check 'No expiration date on packaging' before saving.",
      target: "expiration",
    });
  } else if (input.traceabilityRequired && !input.expiryDate.trim()) {
    issues.push({
      code: "expiration_date",
      title: "Expiration required",
      message: "Expiration date is required for this item.",
      target: "expiration",
    });
  }
  if (input.needsEvidence && input.evidenceCount === 0) {
    const issueLabels = input.tags
      .filter((t) => t !== ITEM_UNIT_SELLABLE_OK_TAG)
      .map((t) => CHIP_LABEL[t])
      .join(", ");
    const issuePhrase = issueLabels || "the selected issue(s)";
    issues.push({
      code: "evidence_photo",
      title: VALIDATION_ISSUE_TITLE.EVIDENCE,
      message: `Add at least one evidence photo for ${issuePhrase} before saving.`,
      target: "evidence",
    });
  }
  return issues;
}

function isItemUnitValidationIssueActive(
  issue: ItemUnitValidationIssue,
  input: {
    barcode: string;
    tags: ItemUnitDiscrepancyTagKey[];
    hasExpiredTag: boolean;
    noExpiryChecked: boolean;
    expiryDate: string;
    traceabilityRequired: boolean;
    needsEvidence: boolean;
    evidenceCount: number;
  },
): boolean {
  switch (issue.target) {
    case "barcode":
      return !input.barcode.trim();
    case "condition":
      return input.tags.length === 0;
    case "expiration":
      if (input.hasExpiredTag && !input.noExpiryChecked && !input.expiryDate.trim()) return true;
      return input.traceabilityRequired && !input.expiryDate.trim();
    case "evidence":
      return input.needsEvidence && input.evidenceCount === 0;
    case "allocation":
      return true;
    default:
      return false;
  }
}

export type ItemUnitRecordModalInitialState = {
  selectedTags: ItemUnitDiscrepancyTagKey[];
  expiryDate: string;
  lotNumber: string;
  noExpiryChecked: boolean;
  evidenceUrls: string[];
  optionalItemPhotoUrl: string | null;
  operatorNotes: string;
};

type ItemUnitRecordModalProps = {
  open: boolean;
  mode?: "create" | "edit";
  title?: string;
  subtitle?: string | null;
  saveLabel?: string;
  barcodeReadOnly?: boolean;
  initialBarcode: string;
  initialState?: ItemUnitRecordModalInitialState | null;
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
  onSave: (payload: ItemUnitRecordSavePayload) => Promise<ItemUnitRecordSaveResult>;
};

export function ItemUnitRecordModal(props: ItemUnitRecordModalProps) {
  const {
    open,
    mode = "create",
    title = "Record scanned unit",
    subtitle,
    saveLabel,
    barcodeReadOnly = false,
    initialBarcode,
    initialState = null,
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

  const isEditMode = mode === "edit";
  const primarySaveLabel = saveLabel ?? (isEditMode ? "Save changes" : "Save unit");

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
  const [validationIssues, setValidationIssues] = useState<ItemUnitValidationIssue[]>([]);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [uploadingOptionalPhoto, setUploadingOptionalPhoto] = useState(false);
  const [manualBarcodeEntry, setManualBarcodeEntry] = useState(false);
  const [photoMenuTarget, setPhotoMenuTarget] = useState<ItemUnitPhotoMenuTarget | null>(null);
  const optionalCameraInputRef = useRef<HTMLInputElement>(null);
  const optionalUploadInputRef = useRef<HTMLInputElement>(null);
  const evidenceCameraInputRef = useRef<HTMLInputElement>(null);
  const evidenceUploadInputRef = useRef<HTMLInputElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const expiryInputRef = useRef<HTMLInputElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const validationSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLiveLinkage(productLinkage);
  }, [productLinkage]);

  useEffect(() => {
    if (!open) return;
    setBarcode(initialBarcode.trim());
    setLiveLinkage(productLinkage);
    if (initialState) {
      setSelectedTags(
        initialState.selectedTags.length > 0
          ? normalizeItemUnitDiscrepancySelection(initialState.selectedTags)
          : [ITEM_UNIT_SELLABLE_OK_TAG],
      );
      setExpiryDate(initialState.expiryDate);
      setLotNumber(initialState.lotNumber);
      setNoExpiryChecked(initialState.noExpiryChecked);
      setEvidenceUrls(initialState.evidenceUrls);
      setOptionalItemPhotoUrl(initialState.optionalItemPhotoUrl);
      setOperatorNotes(initialState.operatorNotes);
    } else {
      setSelectedTags([ITEM_UNIT_SELLABLE_OK_TAG]);
      setExpiryDate("");
      setLotNumber("");
      setNoExpiryChecked(false);
      setEvidenceUrls([]);
      setOptionalItemPhotoUrl(null);
      setOperatorNotes("");
    }
    setValidationIssues([]);
    setLinkageResolving(false);
    setManualBarcodeEntry(false);
    setPhotoMenuTarget(null);
  }, [open, initialBarcode, productLinkage, initialState]);

  const scrollToValidationSummary = useCallback(() => {
    window.requestAnimationFrame(() => {
      scrollBodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      validationSummaryRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, []);

  const showValidationIssues = useCallback(
    (issues: ItemUnitValidationIssue[]) => {
      setValidationIssues(issues);
      scrollToValidationSummary();
    },
    [scrollToValidationSummary],
  );

  const openOptionalPhotoMenu = useCallback(() => {
    if (busy || uploadingOptionalPhoto) return;
    setPhotoMenuTarget("optional");
  }, [busy, uploadingOptionalPhoto]);

  const openEvidencePhotoMenu = useCallback(() => {
    if (busy || uploadingEvidence) return;
    setPhotoMenuTarget("evidence");
  }, [busy, uploadingEvidence]);

  const startManualBarcodeEntry = useCallback(() => {
    if (busy || barcodeReadOnly) return;
    setManualBarcodeEntry(true);
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
    window.requestAnimationFrame(focusBarcode);
  }, [barcodeReadOnly]);

  useEffect(() => {
    if (!open || !resolveBarcodeLinkage || barcodeReadOnly) return;
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
  const hasExpiredTag = normalizedTags.includes("expired");

  const validationContext = useMemo(
    () => ({
      barcode,
      tags: normalizedTags,
      hasExpiredTag,
      noExpiryChecked,
      expiryDate,
      traceabilityRequired,
      needsEvidence,
      evidenceCount: evidenceUrls.length,
    }),
    [
      barcode,
      normalizedTags,
      hasExpiredTag,
      noExpiryChecked,
      expiryDate,
      traceabilityRequired,
      needsEvidence,
      evidenceUrls.length,
    ],
  );

  useEffect(() => {
    setValidationIssues((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((issue) => isItemUnitValidationIssueActive(issue, validationContext));
      return next.length === prev.length ? prev : next;
    });
  }, [validationContext]);

  const issueForTarget = useCallback(
    (target: ItemUnitValidationTarget) => validationIssues.find((issue) => issue.target === target) ?? null,
    [validationIssues],
  );
  const expirationInlineError = issueForTarget("expiration")?.message ?? null;
  const evidenceInlineError = issueForTarget("evidence")?.message ?? null;
  const barcodeInlineError = issueForTarget("barcode")?.message ?? null;
  const conditionInlineError = issueForTarget("condition")?.message ?? null;
  const allocationInlineError = issueForTarget("allocation")?.message ?? null;

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
    setValidationIssues((prev) => prev.filter((issue) => issue.target === "allocation"));
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
        showValidationIssues([
          {
            code: "upload_org",
            title: "Upload failed",
            message: "Organization missing — cannot upload photos.",
            target: "allocation",
          },
        ]);
        return;
      }
      const setUploading = mode === "evidence" ? setUploadingEvidence : setUploadingOptionalPhoto;
      setUploading(true);
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
            showValidationIssues([
              {
                code: "upload_optional",
                title: "Upload failed",
                message: res.error,
                target: "allocation",
              },
            ]);
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
              showValidationIssues([
                {
                  code: "upload_evidence",
                  title: "Upload failed",
                  message: res.error,
                  target: "evidence",
                },
              ]);
              break;
            }
            nextUrls.push(res.publicUrl);
          }
          setEvidenceUrls(nextUrls);
        }
      } finally {
        setUploading(false);
        if (mode === "evidence") {
          if (evidenceCameraInputRef.current) evidenceCameraInputRef.current.value = "";
          if (evidenceUploadInputRef.current) evidenceUploadInputRef.current.value = "";
        }
        if (mode === "optional") {
          if (optionalCameraInputRef.current) optionalCameraInputRef.current.value = "";
          if (optionalUploadInputRef.current) optionalUploadInputRef.current.value = "";
        }
      }
    },
    [evidenceUrls, organizationId, showValidationIssues],
  );

  const handleSave = useCallback(async () => {
    const tags = normalizeItemUnitDiscrepancySelection(selectedTags);
    const clientIssues = validateItemUnitBeforeSave({
      barcode,
      tags,
      hasExpiredTag,
      noExpiryChecked,
      expiryDate,
      traceabilityRequired,
      needsEvidence,
      evidenceCount: evidenceUrls.length,
    });
    if (clientIssues.length > 0) {
      showValidationIssues(clientIssues);
      return;
    }
    setManualBarcodeEntry(false);
    barcodeInputRef.current?.blur();

    const tr = packageItemRequiresExpiryBlock({ tags, slipDescription }) && !noExpiryChecked;
    const gallery = [...evidenceUrls];
    if (optionalItemPhotoUrl) gallery.push(optionalItemPhotoUrl);

    const saveResult = await onSave({
      scannedBarcode: barcode.trim(),
      discrepancyTags: tags,
      expiryDate: noExpiryChecked ? null : expiryDate.trim() || null,
      lotNumber: noExpiryChecked ? null : lotNumber.trim() || null,
      evidenceUrls: gallery,
      traceabilityRequired: tr,
      optionalItemPhotoUrl,
      operatorNotes: operatorNotes.trim() || null,
    });
    if (!saveResult.ok) {
      showValidationIssues([
        {
          code: "save_failed",
          title: "Save failed",
          message: saveResult.message,
          target: "allocation",
        },
      ]);
      return;
    }
    setValidationIssues([]);
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
    showValidationIssues,
    hasExpiredTag,
    traceabilityRequired,
  ]);

  if (!open) return null;

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
                  className="operator-item-unit-record-modal__link text-[12px] font-bold leading-snug underline underline-offset-2"
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
            className="operator-item-unit-record-modal__close-btn rounded-xl p-2 transition disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {validationIssues.length > 0 ? (
          <div
            ref={validationSummaryRef}
            role="alert"
            aria-live="polite"
            className="operator-item-unit-record-modal__validation-summary mx-4 mt-3 shrink-0 rounded-lg border px-3 py-2"
          >
            <p className="text-[12px] font-black leading-snug">Fix before saving</p>
            <ul className="mt-1 space-y-1">
              {validationIssues.map((issue) => (
                <li key={issue.code} className="text-[11px] font-semibold leading-snug">
                  <span className="font-black">{issue.title}:</span> {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div
          ref={scrollBodyRef}
          className="operator-item-unit-record-modal__scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        >
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
            <p className="operator-item-unit-record-modal__muted mt-1 text-[10px] font-semibold leading-snug">
              Scan with your Zebra first — tap{" "}
              <span className="operator-item-unit-record-modal__hint-accent">Tap to type</span> only when you need the
              keyboard.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                ref={barcodeInputRef}
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                onFocus={(e) => {
                  if (!manualBarcodeEntry) e.currentTarget.blur();
                }}
                onBlur={() => {
                  if (!manualBarcodeEntry) return;
                  window.setTimeout(() => setManualBarcodeEntry(false), 120);
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
                className="operator-item-unit-record-modal__barcode-input h-[52px] min-w-0 flex-1 rounded-xl border-2 px-3 font-mono text-[15px] outline-none transition duration-150 focus:ring-0"
                placeholder={manualBarcodeEntry ? "Type barcode…" : "Awaiting scan…"}
                readOnly={barcodeReadOnly || !manualBarcodeEntry}
                inputMode={barcodeReadOnly ? "none" : manualBarcodeEntry ? "text" : "none"}
                autoComplete="off"
                enterKeyHint="done"
                aria-label="Product barcode"
              />
              {!barcodeReadOnly ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={startManualBarcodeEntry}
                  className={`operator-item-unit-record-modal__type-btn flex h-[52px] min-w-[7.25rem] shrink-0 items-center justify-center rounded-xl border-2 px-3 text-[11px] font-black uppercase tracking-wide transition active:scale-[0.98] disabled:opacity-40${manualBarcodeEntry ? " operator-item-unit-record-modal__type-btn--active" : ""}`}
                >
                  Tap to type
                </button>
              ) : null}
            </div>
            {barcodeInlineError ? (
              <p className="operator-item-unit-record-modal__local-error mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold">
                {barcodeInlineError}
              </p>
            ) : null}
          </form>

          <div className="operator-item-unit-record-modal__divider mt-4 border-t pt-4">
            <label className="operator-item-unit-record-modal__section-label text-xs font-semibold uppercase tracking-wider block mb-2">
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
                className="operator-item-unit-record-modal__field-input w-full h-12 border rounded-xl px-4 focus:outline-none disabled:opacity-40 transition-all"
              />
              <label className="operator-item-unit-record-modal__checkbox-label flex items-center gap-2.5 cursor-pointer text-sm select-none mt-1">
                <input
                  type="checkbox"
                  checked={noExpiryChecked}
                  disabled={busy}
                  onChange={(e) => {
                    setNoExpiryChecked(e.target.checked);
                    if (e.target.checked) {
                      setExpiryDate("");
                      setLotNumber("");
                    } else {
                      window.setTimeout(() => expiryInputRef.current?.focus({ preventScroll: true }), 0);
                    }
                  }}
                  className="operator-item-unit-record-modal__checkbox w-4 h-4 rounded focus:ring-0"
                />
                <span>No expiration date on packaging</span>
              </label>
            </div>
            {expirationInlineError ? (
              <p className="operator-item-unit-record-modal__local-error mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold">
                {expirationInlineError}
              </p>
            ) : null}
            {categoryRequiresExpiry && !noExpiryChecked ? (
              <>
                <label className="operator-item-unit-record-modal__muted mt-4 block text-[10px] font-bold uppercase tracking-wide">
                  Batch / lot # (optional)
                </label>
                <input
                  value={lotNumber}
                  disabled={busy}
                  onChange={(e) => setLotNumber(e.target.value)}
                  className="operator-item-unit-record-modal__field-input mt-1.5 h-11 w-full rounded-lg border px-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  placeholder="Lot or batch code"
                />
                <p className="operator-item-unit-record-modal__muted mt-2 text-[10px] font-semibold leading-snug">
                  Optional traceability detail for food, cosmetics, and healthcare lines.
                </p>
              </>
            ) : null}
          </div>

          <p className="operator-item-unit-record-modal__heading mt-5 text-[12px] font-bold">
            What is wrong with this item?
          </p>
          <div className="mt-3 flex flex-wrap gap-2.5" role="group" aria-label="Item condition tags">
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
                  className={`operator-item-unit-record-modal__chip rounded-full border px-3.5 py-2 text-[11px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed ${
                    selected ? "operator-item-unit-record-modal__chip--selected" : ""
                  } ${lockedByMissingItem ? "opacity-50" : "disabled:opacity-40"}`}
                >
                  {CHIP_LABEL[key]}
                </button>
              );
            })}
          </div>
          {conditionInlineError ? (
            <p className="operator-item-unit-record-modal__local-error mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold">
              {conditionInlineError}
            </p>
          ) : null}

          <div className="mt-4">
            <p className="operator-item-unit-record-modal__heading text-[11px] font-bold">Optional item photo (optional)</p>
            <input
              ref={optionalCameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => void uploadFiles(e.target.files, "optional")}
            />
            <input
              ref={optionalUploadInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => void uploadFiles(e.target.files, "optional")}
            />
            <button
              type="button"
              disabled={busy || uploadingOptionalPhoto}
              onClick={openOptionalPhotoMenu}
              className="operator-item-unit-record-modal__dropzone mt-2 flex min-h-[52px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-2 py-2 text-[10px] font-semibold transition disabled:opacity-40"
            >
              {uploadingOptionalPhoto ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ImagePlus className="h-4 w-4 opacity-80" aria-hidden />
              )}
              {optionalItemPhotoUrl ? "Photo attached — tap to replace" : "Take or upload optional photo"}
            </button>
          </div>

          {needsEvidence ? (
            <div className="mt-5">
              <p className="operator-item-unit-record-modal__heading text-[12px] font-bold">Issue evidence</p>
              <p className="operator-item-unit-record-modal__muted mt-1 text-[10px] font-semibold">
                Capture at least one photo that shows the specific problem before saving.
              </p>
              <input
                ref={evidenceCameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void uploadFiles(e.target.files, "evidence")}
              />
              <input
                ref={evidenceUploadInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void uploadFiles(e.target.files, "evidence")}
              />
              <button
                type="button"
                disabled={busy || uploadingEvidence}
                onClick={openEvidencePhotoMenu}
                className="operator-item-unit-record-modal__evidence-btn mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition disabled:opacity-40"
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
                <>
                  <p className="operator-item-unit-record-modal__evidence-warn mt-2 text-[11px] font-semibold">
                    No photos yet — required for this condition.
                  </p>
                  {evidenceInlineError ? (
                    <p className="operator-item-unit-record-modal__local-error mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold">
                      {evidenceInlineError}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {allocationInlineError ? (
            <p className="operator-item-unit-record-modal__local-error mt-4 rounded-lg border px-3 py-2 text-[12px] font-semibold">
              {allocationInlineError}
            </p>
          ) : null}
        </div>

        <div className="operator-item-unit-record-modal__notes-footer shrink-0 border-t px-4 pt-3 pb-2">
          <label
            htmlFor="item-unit-operator-notes"
            className="operator-item-unit-record-modal__section-label text-xs font-semibold uppercase tracking-wider block mb-2"
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
            className="operator-item-unit-record-modal__notes-input w-full min-h-[72px] resize-y rounded-xl border px-4 py-3 text-sm focus:outline-none disabled:opacity-40 transition-all"
          />
        </div>

        <div className="operator-item-unit-record-modal__header shrink-0 border-t p-4">
          <OperatorScannerFooterActions
            primary={
              <button
                type="submit"
                form="item-unit-record-barcode-form"
                disabled={busy}
                className="operator-shipment-flow-modal__btn-primary flex h-12 w-full items-center justify-center gap-2 rounded-xl border text-sm font-black transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} /> : null}
                {primarySaveLabel}
              </button>
            }
            secondary={
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="operator-shipment-flow-modal__btn-secondary h-12 w-full rounded-xl border text-sm font-bold transition active:scale-[0.98] disabled:opacity-40"
              >
                Cancel
              </button>
            }
          />
        </div>
      </div>

      <ScannerPhotoActionSheet
        open={photoMenuTarget !== null}
        onClose={() => setPhotoMenuTarget(null)}
        onTakePhoto={() => {
          const target = photoMenuTarget;
          setPhotoMenuTarget(null);
          if (target === "optional") optionalCameraInputRef.current?.click();
          else if (target === "evidence") evidenceCameraInputRef.current?.click();
        }}
        onUploadPhoto={() => {
          const target = photoMenuTarget;
          setPhotoMenuTarget(null);
          if (target === "optional") optionalUploadInputRef.current?.click();
          else if (target === "evidence") evidenceUploadInputRef.current?.click();
        }}
        disabled={
          busy ||
          (photoMenuTarget === "optional" ? uploadingOptionalPhoto : photoMenuTarget === "evidence" ? uploadingEvidence : false)
        }
        title={photoMenuTarget === "optional" ? "Optional item photo" : "Issue evidence photo"}
      />
    </div>
  );
}
