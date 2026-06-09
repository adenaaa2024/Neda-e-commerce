"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { classifyProductBarcode } from "@/lib/product-barcode-classify";
import { Camera, ImagePlus, Loader2, Trash2, X } from "lucide-react";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";
import { uploadMediaFileAction } from "@/lib/media-upload-actions";
import {
  ITEM_UNIT_ADD_SCAN_DAMAGE_TAG_KEYS,
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
import { operatorBarcodesMatchProduct } from "@/app/scanner/operator-mobile/_lib/operator-barcode-match";
import { playScannerFeedback } from "@/app/scanner/operator-mobile/_lib/scanner-feedback";
import {
  OPERATOR_ITEM_BATCH_CONFIRM_THRESHOLD,
  OPERATOR_ITEM_BATCH_MAX_QUANTITY,
} from "@/lib/scanner/item-batch-allocation";

const CHIP_LABEL: Record<ItemUnitDiscrepancyTagKey, string> = {
  damaged_product: "Damaged Product",
  scratched: "Scratched",
  wrong_item: "Wrong Item",
  expired: "Expired",
  missing_parts: "Missing Parts",
  missing_item: "Missing Item",
  sellable_ok: "Sellable/Ok",
};

/** Set true temporarily to trace delete button visibility in the console. */
const ITEM_UNIT_MODAL_DELETE_DEBUG = false;

function logItemUnitModalDelete(...args: unknown[]) {
  if (!ITEM_UNIT_MODAL_DELETE_DEBUG) return;
  console.log("[item-unit-modal-delete-debug]", ...args);
}

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
  /** Separate evidence photos specifically for the Expired condition (expiry date label, packaging, etc.). */
  expiryEvidenceUrls: string[];
  traceabilityRequired: boolean;
  /** Optional item photo (not required for Sellable/Ok). */
  optionalItemPhotoUrl: string | null;
  /** Operator prose note on the unit (`return_items.notes`). */
  operatorNotes: string | null;
  /** When > 1, batch save creates N `return_items` rows (create mode only). */
  batchQuantity?: number;
};

export type ItemUnitAddMode = "single" | "batch";
export type ItemUnitBatchMethod = "manual" | "scan_to_count";

export type ItemUnitScanToCountSession = {
  active: boolean;
  onBarcodeScan: (code: string) => void;
} | null;

export type ItemUnitBarcodeCaptureSession = ItemUnitScanToCountSession;

type ItemUnitPhotoMenuTarget = "optional" | "evidence" | "expiry_evidence";

function validateItemUnitBeforeSave(input: {
  barcode: string;
  tags: ItemUnitDiscrepancyTagKey[];
  hasExpiredTag: boolean;
  noExpiryChecked: boolean;
  expiryDate: string;
  needsEvidence: boolean;
  evidenceCount: number;
  expiryEvidenceCount: number;
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
  if (input.hasExpiredTag) {
    if (!input.expiryDate.trim()) {
      issues.push({
        code: "expiration_date",
        title: VALIDATION_ISSUE_TITLE.EXPIRATION_DATE,
        message: "Expiration date is required for Expired items.",
        target: "expiration",
      });
    }
  } else if (!input.noExpiryChecked && !input.expiryDate.trim()) {
    issues.push({
      code: "expiration_date",
      title: VALIDATION_ISSUE_TITLE.EXPIRATION_DATE,
      message: "Enter the expiration date or check 'No expiration date on packaging' before saving.",
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
  if (input.hasExpiredTag && input.expiryEvidenceCount === 0) {
    issues.push({
      code: "expiry_evidence_photo",
      title: "Expiry photo required",
      message: "Add at least one photo showing the expiry date before saving.",
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
    needsEvidence: boolean;
    evidenceCount: number;
    expiryEvidenceCount: number;
  },
): boolean {
  switch (issue.target) {
    case "barcode":
      return !input.barcode.trim();
    case "condition":
      return input.tags.length === 0;
    case "expiration":
      if (input.hasExpiredTag) return !input.expiryDate.trim();
      return !input.noExpiryChecked && !input.expiryDate.trim();
    case "evidence":
      if (issue.code === "expiry_evidence_photo") return input.hasExpiredTag && input.expiryEvidenceCount === 0;
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
  expiryEvidenceUrls: string[];
  optionalItemPhotoUrl: string | null;
  operatorNotes: string;
};

function normEvidenceUrls(urls: readonly string[]): string[] {
  return urls.map((u) => String(u ?? "").trim()).filter(Boolean);
}

/** True when operator changed modal fields away from the snapshot taken when the modal opened. */
export function itemUnitRecordModalHasUnsavedDraft(input: {
  barcode: string;
  initialBarcode: string;
  initialState: ItemUnitRecordModalInitialState | null;
  selectedTags: ItemUnitDiscrepancyTagKey[];
  expiryDate: string;
  lotNumber: string;
  noExpiryChecked: boolean;
  evidenceUrls: readonly string[];
  optionalItemPhotoUrl: string | null;
  operatorNotes: string;
  manualBarcodeEntry: boolean;
}): boolean {
  if (input.manualBarcodeEntry) return true;
  if (input.barcode.trim() !== input.initialBarcode.trim()) return true;

  const baselineTags = input.initialState?.selectedTags?.length
    ? normalizeItemUnitDiscrepancySelection(input.initialState.selectedTags)
    : [ITEM_UNIT_SELLABLE_OK_TAG];
  const currentTags = normalizeItemUnitDiscrepancySelection(input.selectedTags);
  if (JSON.stringify(currentTags) !== JSON.stringify(baselineTags)) return true;

  const baselineExpiry = input.initialState?.expiryDate ?? "";
  if (input.expiryDate.trim() !== baselineExpiry.trim()) return true;

  const baselineLot = input.initialState?.lotNumber ?? "";
  if (input.lotNumber.trim() !== baselineLot.trim()) return true;

  const baselineNoExpiry = input.initialState?.noExpiryChecked ?? false;
  if (input.noExpiryChecked !== baselineNoExpiry) return true;

  const baselineEvidence = normEvidenceUrls(input.initialState?.evidenceUrls ?? []);
  const currentEvidence = normEvidenceUrls(input.evidenceUrls);
  if (
    baselineEvidence.length !== currentEvidence.length ||
    baselineEvidence.some((u, i) => u !== currentEvidence[i])
  ) {
    return true;
  }

  const baselineOptional = (input.initialState?.optionalItemPhotoUrl ?? "").trim();
  if ((input.optionalItemPhotoUrl ?? "").trim() !== baselineOptional) return true;

  const baselineNotes = (input.initialState?.operatorNotes ?? "").trim();
  if (input.operatorNotes.trim() !== baselineNotes) return true;

  return false;
}

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
  /** Amber warning when save will record an off-slip unit (non-blocking). */
  offSlipWarning?: { title: string; message: string } | null;
  resolveBarcodeLinkage?: (
    barcode: string,
    matchKind: "fnsku" | "upc" | "unexpected",
  ) => Promise<ProductLinkageDisplayContract | null>;
  busy: boolean;
  /** Saved `return_items.id` when editing an existing scanned unit (create mode omits). */
  existingReturnItemId?: string | null;
  onClose: () => void;
  onSave: (payload: ItemUnitRecordSavePayload) => Promise<ItemUnitRecordSaveResult>;
  /** Soft-delete the saved unit currently being edited (edit mode only). */
  onDeleteExistingUnit?: () => Promise<{ ok: boolean; error?: string }>;
  /** Fires when open draft diverges from the modal open snapshot (for scanner back-navigation). */
  onUnsavedDraftChange?: (dirty: boolean) => void;
  /** Registers scan-to-count wedge handler while modal is open (create + batch scan-to-count only). */
  onScanToCountSessionChange?: (session: ItemUnitScanToCountSession) => void;
  /** Live batch quantity for parent off-slip allocation preview (create mode). */
  onBatchQuantityPreviewChange?: (qty: number) => void;
  /** Live barcode for parent off-slip warning gating (create mode). */
  onBarcodeIdentityChange?: (barcode: string) => void;
  /** Live add mode for parent off-slip warning copy (create mode). */
  onAddModeChange?: (mode: ItemUnitAddMode) => void;
  /** True when batch manual qty or scan-to-count target has been entered. */
  onBatchQtyEnteredChange?: (entered: boolean) => void;
  /** Document-level wedge fallback when barcode field is not focused (create mode). */
  onBarcodeCaptureSessionChange?: (session: ItemUnitBarcodeCaptureSession) => void;
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
    offSlipWarning = null,
    resolveBarcodeLinkage,
    busy,
    existingReturnItemId = null,
    onClose,
    onSave,
    onDeleteExistingUnit,
    onUnsavedDraftChange,
    onScanToCountSessionChange,
    onBatchQuantityPreviewChange,
    onBarcodeIdentityChange,
    onAddModeChange,
    onBatchQtyEnteredChange,
    onBarcodeCaptureSessionChange,
  } = props;

  const isEditMode = mode === "edit";
  const savedReturnItemId = String(existingReturnItemId ?? "").trim();
  const canDeleteExistingUnit = Boolean(savedReturnItemId) && Boolean(onDeleteExistingUnit);
  const [addMode, setAddMode] = useState<ItemUnitAddMode>("single");
  const [batchMethod, setBatchMethod] = useState<ItemUnitBatchMethod>("manual");
  const [manualBatchQty, setManualBatchQty] = useState("");
  const [scanToCountTarget, setScanToCountTarget] = useState("");
  const [scanToCountCounted, setScanToCountCounted] = useState(0);
  const [scanToCountLastScan, setScanToCountLastScan] = useState<string | null>(null);
  const [scanToCountMismatch, setScanToCountMismatch] = useState<string | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [barcode, setBarcode] = useState("");
  const [liveLinkage, setLiveLinkage] = useState<ProductLinkageDisplayContract | null>(productLinkage);
  const [linkageResolving, setLinkageResolving] = useState(false);
  const [selectedTags, setSelectedTags] = useState<ItemUnitDiscrepancyTagKey[]>([ITEM_UNIT_SELLABLE_OK_TAG]);
  const [expiryDate, setExpiryDate] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [noExpiryChecked, setNoExpiryChecked] = useState(false);
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [expiryEvidenceUrls, setExpiryEvidenceUrls] = useState<string[]>([]);
  const [optionalItemPhotoUrl, setOptionalItemPhotoUrl] = useState<string | null>(null);
  const [operatorNotes, setOperatorNotes] = useState("");
  const [validationIssues, setValidationIssues] = useState<ItemUnitValidationIssue[]>([]);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [uploadingExpiryEvidence, setUploadingExpiryEvidence] = useState(false);
  const [uploadingOptionalPhoto, setUploadingOptionalPhoto] = useState(false);
  const [manualBarcodeEntry, setManualBarcodeEntry] = useState(false);
  const [photoMenuTarget, setPhotoMenuTarget] = useState<ItemUnitPhotoMenuTarget | null>(null);
  const optionalCameraInputRef = useRef<HTMLInputElement>(null);
  const optionalUploadInputRef = useRef<HTMLInputElement>(null);
  const evidenceCameraInputRef = useRef<HTMLInputElement>(null);
  const evidenceUploadInputRef = useRef<HTMLInputElement>(null);
  const expiryEvidenceCameraInputRef = useRef<HTMLInputElement>(null);
  const expiryEvidenceUploadInputRef = useRef<HTMLInputElement>(null);
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
      setExpiryEvidenceUrls(initialState.expiryEvidenceUrls ?? []);
      setOptionalItemPhotoUrl(initialState.optionalItemPhotoUrl);
      setOperatorNotes(initialState.operatorNotes);
    } else {
      setSelectedTags([ITEM_UNIT_SELLABLE_OK_TAG]);
      setExpiryDate("");
      setLotNumber("");
      setNoExpiryChecked(false);
      setEvidenceUrls([]);
      setExpiryEvidenceUrls([]);
      setOptionalItemPhotoUrl(null);
      setOperatorNotes("");
    }
    setValidationIssues([]);
    setLinkageResolving(false);
    setManualBarcodeEntry(false);
    setPhotoMenuTarget(null);
    setDeleteConfirmOpen(false);
    setDeleteError(null);
    setAddMode("single");
    setBatchMethod("manual");
    setManualBatchQty("");
    setScanToCountTarget("");
    setScanToCountCounted(0);
    setScanToCountLastScan(null);
    setScanToCountMismatch(null);
    setBatchConfirmOpen(false);
  }, [open, initialBarcode, productLinkage, initialState]);

  const resetScanToCountState = useCallback(() => {
    setScanToCountCounted(0);
    setScanToCountLastScan(null);
    setScanToCountMismatch(null);
  }, []);

  /** Batch controls depend on scanned item identity only — not slip linkage or resolver completion. */
  const hasItemIdentityForBatch = barcode.trim().length >= 3;

  useEffect(() => {
    if (!open) return;
    const shouldShowDelete = canDeleteExistingUnit;
    logItemUnitModalDelete({
      modalOpenPath: isEditMode ? "edit" : "create",
      mode,
      existingReturnItemId,
      savedReturnItemId,
      hasOnDeleteExistingUnit: Boolean(onDeleteExistingUnit),
      shouldShowDelete,
      renderedDeleteButton: shouldShowDelete,
    });
  }, [open, mode, isEditMode, existingReturnItemId, savedReturnItemId, onDeleteExistingUnit, canDeleteExistingUnit]);

  useEffect(() => {
    if (!open || !deleteConfirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDeleteConfirmOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, deleteConfirmOpen]);

  const handleRequestDelete = useCallback(() => {
    if (!canDeleteExistingUnit || busy || !onDeleteExistingUnit) return;
    setDeleteError(null);
    setDeleteConfirmOpen(true);
  }, [canDeleteExistingUnit, busy, onDeleteExistingUnit]);

  const handleConfirmDelete = useCallback(async () => {
    if (!onDeleteExistingUnit || busy) return;
    setDeleteError(null);
    const result = await onDeleteExistingUnit();
    if (result.ok) {
      setDeleteConfirmOpen(false);
      return;
    }
    setDeleteConfirmOpen(false);
    setDeleteError(result.error ?? "Could not delete scan record.");
  }, [busy, onDeleteExistingUnit]);

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

  const openExpiryEvidencePhotoMenu = useCallback(() => {
    if (busy || uploadingExpiryEvidence) return;
    setPhotoMenuTarget("expiry_evidence");
  }, [busy, uploadingExpiryEvidence]);

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
          // Always clear — cancelled in-flight requests must not leave resolving stuck true.
          setLinkageResolving(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, barcode, storeId, matchKind, resolveBarcodeLinkage]);

  const normalizedTags = useMemo(() => normalizeItemUnitDiscrepancySelection(selectedTags), [selectedTags]);
  const displayLinkage = liveLinkage ?? productLinkage;

  const parsedManualBatchQty = useMemo(() => {
    const n = Math.floor(Number(manualBatchQty));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [manualBatchQty]);

  const parsedScanToCountTarget = useMemo(() => {
    const n = Math.floor(Number(scanToCountTarget));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [scanToCountTarget]);

  const scanToCountCapturing =
    !isEditMode &&
    addMode === "batch" &&
    batchMethod === "scan_to_count" &&
    hasItemIdentityForBatch &&
    parsedScanToCountTarget > 0 &&
    scanToCountCounted < parsedScanToCountTarget;

  const barcodeWedgeReady = !barcodeReadOnly && !isEditMode && !scanToCountCapturing;

  const batchQtyEntered =
    addMode === "batch" &&
    (batchMethod === "manual" ? parsedManualBatchQty > 0 : parsedScanToCountTarget > 0);

  const effectiveBatchQuantity = useMemo(() => {
    if (isEditMode || addMode !== "batch") return 1;
    if (batchMethod === "manual") return parsedManualBatchQty;
    return parsedScanToCountTarget;
  }, [isEditMode, addMode, batchMethod, parsedManualBatchQty, parsedScanToCountTarget]);

  const scanToCountReady =
    addMode === "batch" &&
    batchMethod === "scan_to_count" &&
    parsedScanToCountTarget > 0 &&
    scanToCountCounted === parsedScanToCountTarget;

  const primarySaveLabel = useMemo(() => {
    if (saveLabel) return saveLabel;
    if (isEditMode) return "Save changes";
    if (addMode === "batch") {
      const qty = batchMethod === "manual" ? parsedManualBatchQty : parsedScanToCountTarget;
      if (qty > 0) return `Save ${qty} units`;
      return "Save units";
    }
    return "Save unit";
  }, [
    saveLabel,
    isEditMode,
    addMode,
    batchMethod,
    parsedManualBatchQty,
    parsedScanToCountTarget,
  ]);

  const scanToCountFooterHint = useMemo(() => {
    if (addMode !== "batch" || batchMethod !== "scan_to_count") return null;
    if (parsedScanToCountTarget < 1) return "Enter a target quantity to start scan-to-count.";
    if (!scanToCountReady) {
      return `Scan ${parsedScanToCountTarget - scanToCountCounted} more matching barcode(s) to enable save.`;
    }
    return null;
  }, [
    addMode,
    batchMethod,
    parsedScanToCountTarget,
    scanToCountReady,
    scanToCountCounted,
  ]);

  const saveDisabledForScanToCount =
    addMode === "batch" && batchMethod === "scan_to_count" && !scanToCountReady;

  const categoryRequiresExpiry = useMemo(
    () =>
      packageItemRequiresExpiryBlock({
        tags: normalizedTags,
        slipDescription,
      }),
    [normalizedTags, slipDescription],
  );

  const hasExpiredTag = normalizedTags.includes("expired");
  const expiryDateRequired = hasExpiredTag || !noExpiryChecked;
  const needsEvidence = packageItemRequiresEvidencePhotos(normalizedTags);

  const validationContext = useMemo(
    () => ({
      barcode,
      tags: normalizedTags,
      hasExpiredTag,
      noExpiryChecked,
      expiryDate,
      needsEvidence,
      evidenceCount: evidenceUrls.length,
      expiryEvidenceCount: expiryEvidenceUrls.length,
    }),
    [
      barcode,
      normalizedTags,
      hasExpiredTag,
      noExpiryChecked,
      expiryDate,
      needsEvidence,
      evidenceUrls.length,
      expiryEvidenceUrls.length,
    ],
  );

  const batchDraftDirty = useMemo(() => {
    if (isEditMode) return false;
    if (addMode !== "single") return true;
    if (manualBatchQty.trim()) return true;
    if (scanToCountTarget.trim() || scanToCountCounted > 0) return true;
    return false;
  }, [isEditMode, addMode, manualBatchQty, scanToCountTarget, scanToCountCounted]);

  const unsavedDraft = useMemo(
    () =>
      open
        ? itemUnitRecordModalHasUnsavedDraft({
            barcode,
            initialBarcode,
            initialState,
            selectedTags,
            expiryDate,
            lotNumber,
            noExpiryChecked,
            evidenceUrls,
            optionalItemPhotoUrl,
            operatorNotes,
            manualBarcodeEntry,
          }) || batchDraftDirty
        : false,
    [
      open,
      barcode,
      initialBarcode,
      initialState,
      selectedTags,
      expiryDate,
      lotNumber,
      noExpiryChecked,
      evidenceUrls,
      optionalItemPhotoUrl,
      operatorNotes,
      manualBarcodeEntry,
      batchDraftDirty,
    ],
  );

  useEffect(() => {
    if (!open) {
      onUnsavedDraftChange?.(false);
      onBatchQuantityPreviewChange?.(1);
      return;
    }
    onUnsavedDraftChange?.(unsavedDraft);
    const previewQty =
      !isEditMode && addMode === "batch"
        ? Math.max(
            effectiveBatchQuantity,
            batchMethod === "manual" ? parsedManualBatchQty : parsedScanToCountTarget,
          )
        : 1;
    onBatchQuantityPreviewChange?.(previewQty > 0 ? previewQty : 1);
  }, [
    open,
    unsavedDraft,
    onUnsavedDraftChange,
    isEditMode,
    addMode,
    batchMethod,
    effectiveBatchQuantity,
    parsedManualBatchQty,
    parsedScanToCountTarget,
    onBatchQuantityPreviewChange,
  ]);

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
      return false;
    },
    [busy],
  );

  const legacyMissingItemTag = selectedTags.includes("missing_item");

  const toggleTag = useCallback((key: ItemUnitDiscrepancyTagKey) => {
    if (busy) return;
    if (key === "expired") {
      setNoExpiryChecked(false);
    }
    setValidationIssues((prev) => prev.filter((issue) => issue.target === "allocation"));
    setSelectedTags((prev) => {
      if (prev.includes(key)) {
        const next = prev.filter((t) => t !== key);
        return next.length > 0 ? next : [ITEM_UNIT_SELLABLE_OK_TAG];
      }
      if (key === ITEM_UNIT_SELLABLE_OK_TAG) return [ITEM_UNIT_SELLABLE_OK_TAG];
      const withoutExclusive = prev.filter((t) => t !== ITEM_UNIT_SELLABLE_OK_TAG && t !== "missing_item");
      return [...withoutExclusive, key];
    });
  }, [busy]);

  useEffect(() => {
    if (hasExpiredTag && noExpiryChecked) {
      setNoExpiryChecked(false);
    }
  }, [hasExpiredTag, noExpiryChecked]);

  useEffect(() => {
    resetScanToCountState();
  }, [addMode, batchMethod, barcode, resetScanToCountState]);

  useEffect(() => {
    if (batchMethod === "scan_to_count") resetScanToCountState();
  }, [scanToCountTarget, batchMethod, resetScanToCountState]);

  const commitBarcodeFromWedge = useCallback(
    (rawCode: string) => {
      const trimmed = rawCode.trim();
      if (!trimmed || busy || barcodeReadOnly || scanToCountCapturing) return;
      setManualBarcodeEntry(false);
      setBarcode(trimmed);
      playScannerFeedback("success");
      if (!resolveBarcodeLinkage) return;
      const classified = classifyProductBarcode(trimmed);
      const mk: "fnsku" | "upc" | "unexpected" =
        classified.kind === "fnsku" ? "fnsku" : classified.kind === "upc_ean" ? "upc" : "unexpected";
      setLinkageResolving(true);
      void resolveBarcodeLinkage(trimmed, mk)
        .then((linkage) => setLiveLinkage(linkage))
        .finally(() => setLinkageResolving(false));
    },
    [busy, barcodeReadOnly, scanToCountCapturing, resolveBarcodeLinkage],
  );

  const handleScanToCountBarcode = useCallback(
    (scannedCode: string) => {
      const code = scannedCode.trim();
      if (!code || busy) return;
      const target = parsedScanToCountTarget;
      if (target < 1) return;
      if (scanToCountCounted >= target) return;

      if (!operatorBarcodesMatchProduct(barcode, code)) {
        setScanToCountMismatch(`Scanned "${code}" does not match this product.`);
        playScannerFeedback("error");
        return;
      }

      setScanToCountMismatch(null);
      setScanToCountLastScan(code);
      setScanToCountCounted((prev) => {
        const next = Math.min(target, prev + 1);
        if (next >= target) {
          playScannerFeedback("complete");
        } else {
          playScannerFeedback("success");
        }
        return next;
      });
    },
    [barcode, busy, parsedScanToCountTarget, scanToCountCounted],
  );

  useEffect(() => {
    if (!open || !onScanToCountSessionChange || isEditMode) {
      onScanToCountSessionChange?.(null);
      return;
    }
    const active =
      addMode === "batch" &&
      batchMethod === "scan_to_count" &&
      hasItemIdentityForBatch &&
      parsedScanToCountTarget > 0 &&
      scanToCountCounted < parsedScanToCountTarget;
    if (active) {
      onScanToCountSessionChange({ active: true, onBarcodeScan: handleScanToCountBarcode });
      return () => onScanToCountSessionChange(null);
    }
    onScanToCountSessionChange(null);
    return () => onScanToCountSessionChange(null);
  }, [
    open,
    isEditMode,
    addMode,
    batchMethod,
    hasItemIdentityForBatch,
    parsedScanToCountTarget,
    scanToCountCounted,
    handleScanToCountBarcode,
    onScanToCountSessionChange,
  ]);

  useEffect(() => {
    if (!open || !onBarcodeCaptureSessionChange || !barcodeWedgeReady) {
      onBarcodeCaptureSessionChange?.(null);
      return;
    }
    onBarcodeCaptureSessionChange({
      active: true,
      onBarcodeScan: commitBarcodeFromWedge,
    });
    return () => onBarcodeCaptureSessionChange(null);
  }, [open, barcodeWedgeReady, commitBarcodeFromWedge, onBarcodeCaptureSessionChange]);

  useEffect(() => {
    if (!open) {
      onBarcodeIdentityChange?.("");
      onAddModeChange?.("single");
      onBatchQtyEnteredChange?.(false);
      return;
    }
    onBarcodeIdentityChange?.(barcode);
    onAddModeChange?.(addMode);
    onBatchQtyEnteredChange?.(batchQtyEntered);
  }, [
    open,
    barcode,
    addMode,
    batchQtyEntered,
    onBarcodeIdentityChange,
    onAddModeChange,
    onBatchQtyEnteredChange,
  ]);

  useEffect(() => {
    if (!open || !barcodeWedgeReady) return;
    const frame = window.requestAnimationFrame(() => {
      barcodeInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, barcodeWedgeReady, initialBarcode]);

  useEffect(() => {
    if (!scanToCountCapturing) return;
    barcodeInputRef.current?.blur();
  }, [scanToCountCapturing]);

  const validateBatchQuantity = useCallback((): ItemUnitValidationIssue[] => {
    if (isEditMode || addMode !== "batch") return [];
    const issues: ItemUnitValidationIssue[] = [];
    if (batchMethod === "manual") {
      if (parsedManualBatchQty < 1) {
        issues.push({
          code: "batch_quantity",
          title: "Quantity required",
          message: "Enter a positive whole number for batch quantity.",
          target: "allocation",
        });
      } else if (parsedManualBatchQty > OPERATOR_ITEM_BATCH_MAX_QUANTITY) {
        issues.push({
          code: "batch_quantity_max",
          title: "Quantity too large",
          message: `Maximum ${OPERATOR_ITEM_BATCH_MAX_QUANTITY} units per batch save.`,
          target: "allocation",
        });
      }
    } else {
      if (parsedScanToCountTarget < 1) {
        issues.push({
          code: "batch_target",
          title: "Target quantity required",
          message: "Enter a positive target quantity for scan-to-count.",
          target: "allocation",
        });
      } else if (parsedScanToCountTarget > OPERATOR_ITEM_BATCH_MAX_QUANTITY) {
        issues.push({
          code: "batch_target_max",
          title: "Target too large",
          message: `Maximum ${OPERATOR_ITEM_BATCH_MAX_QUANTITY} units per batch save.`,
          target: "allocation",
        });
      } else if (!scanToCountReady) {
        issues.push({
          code: "batch_scan_incomplete",
          title: "Scan count incomplete",
          message: `Scan ${parsedScanToCountTarget - scanToCountCounted} more matching barcode(s) before saving.`,
          target: "allocation",
        });
      }
    }
    return issues;
  }, [
    isEditMode,
    addMode,
    batchMethod,
    parsedManualBatchQty,
    parsedScanToCountTarget,
    scanToCountReady,
    scanToCountCounted,
  ]);

  const uploadFiles = useCallback(
    async (files: FileList | null, mode: "evidence" | "optional" | "expiry_evidence") => {
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
      const setUploading =
        mode === "evidence"
          ? setUploadingEvidence
          : mode === "expiry_evidence"
            ? setUploadingExpiryEvidence
            : setUploadingOptionalPhoto;
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
        } else if (mode === "expiry_evidence") {
          const nextUrls: string[] = [...expiryEvidenceUrls];
          for (const file of Array.from(files)) {
            if (nextUrls.length >= 5) break;
            const fd = new FormData();
            fd.append("file", file);
            fd.append("bucket", "media");
            fd.append("folder", "packages");
            fd.append("organization_id", oid);
            const res = await uploadMediaFileAction(fd);
            if (!res.ok) {
              showValidationIssues([
                {
                  code: "upload_expiry_evidence",
                  title: "Upload failed",
                  message: res.error,
                  target: "evidence",
                },
              ]);
              break;
            }
            nextUrls.push(res.publicUrl);
          }
          setExpiryEvidenceUrls(nextUrls);
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
        if (mode === "expiry_evidence") {
          if (expiryEvidenceCameraInputRef.current) expiryEvidenceCameraInputRef.current.value = "";
          if (expiryEvidenceUploadInputRef.current) expiryEvidenceUploadInputRef.current.value = "";
        }
        if (mode === "optional") {
          if (optionalCameraInputRef.current) optionalCameraInputRef.current.value = "";
          if (optionalUploadInputRef.current) optionalUploadInputRef.current.value = "";
        }
      }
    },
    [evidenceUrls, organizationId, showValidationIssues],
  );

  const performSave = useCallback(async () => {
    const tags = normalizeItemUnitDiscrepancySelection(selectedTags);
    const gallery = [...evidenceUrls];
    if (optionalItemPhotoUrl) gallery.push(optionalItemPhotoUrl);
    const batchQty = !isEditMode && addMode === "batch" ? effectiveBatchQuantity : 1;

    const saveResult = await onSave({
      scannedBarcode: barcode.trim(),
      discrepancyTags: tags,
      expiryDate: hasExpiredTag ? expiryDate.trim() || null : noExpiryChecked ? null : expiryDate.trim() || null,
      lotNumber: hasExpiredTag || !noExpiryChecked ? lotNumber.trim() || null : null,
      evidenceUrls: gallery,
      expiryEvidenceUrls: [...expiryEvidenceUrls],
      traceabilityRequired: hasExpiredTag || !noExpiryChecked,
      optionalItemPhotoUrl,
      operatorNotes: operatorNotes.trim() || null,
      batchQuantity: batchQty > 1 ? batchQty : undefined,
    });
    if (!saveResult.ok) {
      playScannerFeedback("error");
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
    if (offSlipWarning) {
      playScannerFeedback("warning");
    } else {
      playScannerFeedback(batchQty > 1 ? "complete" : "success");
    }
    setValidationIssues([]);
    setBatchConfirmOpen(false);
  }, [
    barcode,
    selectedTags,
    evidenceUrls,
    expiryEvidenceUrls,
    optionalItemPhotoUrl,
    operatorNotes,
    expiryDate,
    lotNumber,
    noExpiryChecked,
    hasExpiredTag,
    onSave,
    showValidationIssues,
    isEditMode,
    addMode,
    effectiveBatchQuantity,
    offSlipWarning,
  ]);

  const handleSave = useCallback(async () => {
    const tags = normalizeItemUnitDiscrepancySelection(selectedTags);
    const clientIssues = [
      ...validateItemUnitBeforeSave({
        barcode,
        tags,
        hasExpiredTag,
        noExpiryChecked,
        expiryDate,
        needsEvidence,
        evidenceCount: evidenceUrls.length,
        expiryEvidenceCount: expiryEvidenceUrls.length,
      }),
      ...validateBatchQuantity(),
    ];
    if (clientIssues.length > 0) {
      playScannerFeedback("error");
      showValidationIssues(clientIssues);
      return;
    }
    if (
      !isEditMode &&
      addMode === "batch" &&
      effectiveBatchQuantity > OPERATOR_ITEM_BATCH_CONFIRM_THRESHOLD
    ) {
      setBatchConfirmOpen(true);
      return;
    }
    setManualBarcodeEntry(false);
    barcodeInputRef.current?.blur();
    await performSave();
  }, [
    barcode,
    selectedTags,
    needsEvidence,
    evidenceUrls,
    expiryEvidenceUrls,
    hasExpiredTag,
    noExpiryChecked,
    expiryDate,
    validateBatchQuantity,
    showValidationIssues,
    isEditMode,
    addMode,
    effectiveBatchQuantity,
    performSave,
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
            onClick={() => {
              if (deleteConfirmOpen) {
                setDeleteConfirmOpen(false);
                return;
              }
              onClose();
            }}
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
                onFocus={() => {
                  if (barcodeReadOnly || scanToCountCapturing) return;
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
                readOnly={barcodeReadOnly || scanToCountCapturing}
                inputMode={
                  barcodeReadOnly || scanToCountCapturing ? "none" : manualBarcodeEntry ? "text" : "none"
                }
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

          {!isEditMode && hasItemIdentityForBatch ? (
            <div className="operator-item-unit-record-modal__batch-section mt-4 rounded-xl border px-3 py-3">
              <p className="operator-item-unit-record-modal__section-label text-xs font-semibold uppercase tracking-wider">
                Add mode
              </p>
              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Add mode">
                {(
                  [
                    ["single", "Single unit"],
                    ["batch", "Batch quantity"],
                  ] as const
                ).map(([key, label]) => {
                  const selected = addMode === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={busy}
                      onClick={() => setAddMode(key)}
                      className={`operator-item-unit-record-modal__chip rounded-full border px-3 py-2 text-[11px] font-bold transition active:scale-[0.98] disabled:opacity-40${
                        selected ? " operator-item-unit-record-modal__chip--selected" : ""
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {addMode === "batch" ? (
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="operator-item-unit-record-modal__muted text-[10px] font-bold uppercase tracking-wide">
                      Method
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Batch method">
                      {(
                        [
                          ["manual", "Manual quantity"],
                          ["scan_to_count", "Scan-to-count"],
                        ] as const
                      ).map(([key, label]) => {
                        const selected = batchMethod === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={busy}
                            onClick={() => setBatchMethod(key)}
                            className={`operator-item-unit-record-modal__chip rounded-full border px-3 py-2 text-[11px] font-bold transition active:scale-[0.98] disabled:opacity-40${
                              selected ? " operator-item-unit-record-modal__chip--selected" : ""
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {batchMethod === "manual" ? (
                    <div>
                      <label className="operator-item-unit-record-modal__muted text-[10px] font-bold uppercase tracking-wide">
                        Quantity
                      </label>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={OPERATOR_ITEM_BATCH_MAX_QUANTITY}
                        disabled={busy}
                        value={manualBatchQty}
                        onChange={(e) => setManualBatchQty(e.target.value.replace(/[^\d]/g, ""))}
                        className="operator-item-unit-record-modal__field-input operator-item-unit-record-modal__batch-qty-input mt-1.5 h-11 w-full rounded-lg border px-3 text-sm outline-none disabled:opacity-40"
                        placeholder="e.g. 50"
                        aria-label="Batch quantity"
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div>
                        <label className="operator-item-unit-record-modal__muted text-[10px] font-bold uppercase tracking-wide">
                          Target quantity
                        </label>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={OPERATOR_ITEM_BATCH_MAX_QUANTITY}
                          disabled={busy}
                          value={scanToCountTarget}
                          onChange={(e) => setScanToCountTarget(e.target.value.replace(/[^\d]/g, ""))}
                          className="operator-item-unit-record-modal__field-input operator-item-unit-record-modal__batch-qty-input mt-1.5 h-11 w-full rounded-lg border px-3 text-sm outline-none disabled:opacity-40"
                          placeholder="e.g. 10"
                          aria-label="Scan-to-count target quantity"
                        />
                      </div>
                      {parsedScanToCountTarget > 0 ? (
                        <div className="operator-item-unit-record-modal__scan-count-panel rounded-lg border px-3 py-2.5">
                          <p className="operator-item-unit-record-modal__scan-count-line text-[13px] font-black">
                            Counted: {scanToCountCounted} / {parsedScanToCountTarget}
                          </p>
                          {scanToCountLastScan ? (
                            <p className="operator-item-unit-record-modal__muted mt-1 font-mono text-[11px] font-semibold">
                              Last scan: {scanToCountLastScan}
                            </p>
                          ) : (
                            <p className="operator-item-unit-record-modal__muted mt-1 text-[10px] font-semibold">
                              Scan the same barcode repeatedly to count units.
                            </p>
                          )}
                          {scanToCountReady ? (
                            <p className="operator-item-unit-record-modal__scan-count-ready mt-2 text-[11px] font-bold">
                              Ready to save {parsedScanToCountTarget} units
                            </p>
                          ) : null}
                          {scanToCountMismatch ? (
                            <p className="operator-item-unit-record-modal__local-error mt-2 rounded-lg border px-2 py-1.5 text-[10px] font-semibold">
                              {scanToCountMismatch}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="operator-item-unit-record-modal__divider mt-4 border-t pt-4">
            <label className="operator-item-unit-record-modal__section-label text-xs font-semibold uppercase tracking-wider block mb-2">
              Expiration Date
              {expiryDateRequired ? (
                <span className="operator-item-unit-record-modal__required-mark ml-1 normal-case font-black tracking-normal">
                  (Required)
                </span>
              ) : null}
              <span className="operator-item-unit-record-modal__muted normal-case font-semibold tracking-normal">
                {" "}
                & Traceability
              </span>
            </label>
            <div className="flex flex-col gap-3">
              <input
                ref={expiryInputRef}
                type="date"
                disabled={busy || (noExpiryChecked && !hasExpiredTag)}
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                aria-required={expiryDateRequired}
                aria-invalid={Boolean(expirationInlineError)}
                className={`operator-item-unit-record-modal__field-input w-full h-12 border rounded-xl px-4 focus:outline-none disabled:opacity-40 transition-all${expirationInlineError ? " operator-item-unit-record-modal__field-input--invalid" : ""}`}
              />
              {!hasExpiredTag ? (
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
              ) : null}
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
            {([...ITEM_UNIT_ADD_SCAN_DAMAGE_TAG_KEYS, ITEM_UNIT_SELLABLE_OK_TAG] as const).map((key) => {
              const selected = selectedTags.includes(key);
              const disabled = isConditionChipDisabled(key);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleTag(key)}
                  className={`operator-item-unit-record-modal__chip rounded-full border px-3.5 py-2 text-[11px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed ${
                    selected ? "operator-item-unit-record-modal__chip--selected" : ""
                  } disabled:opacity-40`}
                >
                  {CHIP_LABEL[key]}
                </button>
              );
            })}
          </div>
          {legacyMissingItemTag ? (
            <p className="operator-item-unit-record-modal__muted mt-2 rounded-lg border border-amber-500/35 bg-amber-950/20 px-3 py-2 text-[10px] font-semibold leading-snug text-amber-200/90">
              Legacy tag: Missing Item (read-only). Record missing expected units on the package review screen instead.
            </p>
          ) : null}
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
                <div className="mt-2 flex flex-wrap gap-2">
                  {evidenceUrls.map((u) => (
                    <img
                      key={u}
                      src={u}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-md border border-white/10 object-cover"
                    />
                  ))}
                </div>
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

          {/* Separate expiry photo section — only when "Expired" tag is selected */}
          {hasExpiredTag ? (
            <div className="mt-5">
              <p className="operator-item-unit-record-modal__heading text-[12px] font-bold">Expiry date photo</p>
              <p className="operator-item-unit-record-modal__muted mt-1 text-[10px] font-semibold">
                Capture at least one photo showing the expiry date on the packaging before saving.
              </p>
              <input
                ref={expiryEvidenceCameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void uploadFiles(e.target.files, "expiry_evidence")}
              />
              <input
                ref={expiryEvidenceUploadInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void uploadFiles(e.target.files, "expiry_evidence")}
              />
              <button
                type="button"
                disabled={busy || uploadingExpiryEvidence}
                onClick={openExpiryEvidencePhotoMenu}
                className="operator-item-unit-record-modal__evidence-btn mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition disabled:opacity-40"
              >
                {uploadingExpiryEvidence ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Camera className="h-5 w-5" strokeWidth={2} />
                )}
                Capture expiry photo
              </button>
              {expiryEvidenceUrls.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {expiryEvidenceUrls.map((u) => (
                    <img
                      key={u}
                      src={u}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-md border border-white/10 object-cover"
                    />
                  ))}
                </div>
              ) : (
                <p className="operator-item-unit-record-modal__evidence-warn mt-2 text-[11px] font-semibold">
                  No expiry photo yet — required when Expired is selected.
                </p>
              )}
            </div>
          ) : null}

          {offSlipWarning && !allocationInlineError ? (
            <div
              className="operator-item-unit-record-modal__allocation-warn mt-4 rounded-lg border px-3 py-2 text-[12px] font-semibold leading-snug"
              role="status"
            >
              <p className="operator-item-unit-record-modal__allocation-warn-title text-[13px] font-black">
                {offSlipWarning.title}
              </p>
              <p className="mt-1 font-semibold">{offSlipWarning.message}</p>
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

        <div className="operator-item-unit-record-modal__footer shrink-0 border-t p-4">
          {deleteError ? (
            <p
              className="operator-item-unit-record-modal__local-error mb-3 rounded-lg border px-3 py-2 text-[12px] font-semibold"
              role="alert"
            >
              {deleteError}
            </p>
          ) : null}
          {scanToCountFooterHint ? (
            <p className="operator-item-unit-record-modal__muted mb-3 text-center text-[11px] font-semibold leading-snug">
              {scanToCountFooterHint}
            </p>
          ) : null}
          {canDeleteExistingUnit ? (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleRequestDelete();
              }}
              className="operator-item-unit-record-modal__delete-btn mb-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="operator-item-unit-record-modal__delete-btn-icon h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
              Delete unit
            </button>
          ) : null}
          <OperatorScannerFooterActions
            primary={
              <button
                type="submit"
                form="item-unit-record-barcode-form"
                disabled={busy || saveDisabledForScanToCount}
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
                onClick={() => {
                  if (deleteConfirmOpen) {
                    setDeleteConfirmOpen(false);
                    return;
                  }
                  onClose();
                }}
                className="operator-shipment-flow-modal__btn-secondary h-12 w-full rounded-xl border text-sm font-bold transition active:scale-[0.98] disabled:opacity-40"
              >
                Cancel
              </button>
            }
          />
        </div>
      </div>

      {typeof document !== "undefined" && batchConfirmOpen
        ? createPortal(
            <div
              className="operator-shipment-flow-modal fixed inset-0 z-[210] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="item-unit-batch-confirm-title"
            >
              <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
                <p
                  id="item-unit-batch-confirm-title"
                  className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
                >
                  Add {effectiveBatchQuantity} units?
                </p>
                <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
                  This will create {effectiveBatchQuantity} scanned units for this item.
                </p>
                <OperatorScannerFooterActions
                  className="mt-6"
                  primary={
                    <button
                      type="button"
                      disabled={busy}
                      className="operator-shipment-flow-modal__btn-primary h-11 w-full rounded-xl border text-[13px] font-black transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => {
                        void performSave();
                      }}
                    >
                      Add units
                    </button>
                  }
                  secondary={
                    <button
                      type="button"
                      disabled={busy}
                      className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-40"
                      onClick={() => setBatchConfirmOpen(false)}
                    >
                      Cancel
                    </button>
                  }
                />
              </div>
            </div>,
            document.body,
          )
        : null}

      {typeof document !== "undefined" && deleteConfirmOpen
        ? createPortal(
            <div
              className="operator-shipment-flow-modal fixed inset-0 z-[210] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="item-unit-delete-confirm-title"
            >
              <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
                <p
                  id="item-unit-delete-confirm-title"
                  className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
                >
                  Delete scanned unit?
                </p>
                <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
                  This will remove this scanned unit from the box. This action cannot be undone.
                </p>
                <OperatorScannerFooterActions
                  className="mt-6"
                  primary={
                    <button
                      type="button"
                      disabled={busy}
                      className="h-11 w-full rounded-xl border border-red-500/60 bg-red-50 text-[13px] font-bold text-red-900 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-red-950/30 dark:text-red-300"
                      onClick={() => {
                        void handleConfirmDelete();
                      }}
                    >
                      Delete unit
                    </button>
                  }
                  secondary={
                    <button
                      type="button"
                      disabled={busy}
                      className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-40"
                      onClick={() => setDeleteConfirmOpen(false)}
                    >
                      Cancel
                    </button>
                  }
                />
              </div>
            </div>,
            document.body,
          )
        : null}

      <ScannerPhotoActionSheet
        open={photoMenuTarget !== null}
        onClose={() => setPhotoMenuTarget(null)}
        onTakePhoto={() => {
          const target = photoMenuTarget;
          setPhotoMenuTarget(null);
          if (target === "optional") optionalCameraInputRef.current?.click();
          else if (target === "evidence") evidenceCameraInputRef.current?.click();
          else if (target === "expiry_evidence") expiryEvidenceCameraInputRef.current?.click();
        }}
        onUploadPhoto={() => {
          const target = photoMenuTarget;
          setPhotoMenuTarget(null);
          if (target === "optional") optionalUploadInputRef.current?.click();
          else if (target === "evidence") evidenceUploadInputRef.current?.click();
          else if (target === "expiry_evidence") expiryEvidenceUploadInputRef.current?.click();
        }}
        disabled={
          busy ||
          (photoMenuTarget === "optional"
            ? uploadingOptionalPhoto
            : photoMenuTarget === "evidence"
              ? uploadingEvidence
              : photoMenuTarget === "expiry_evidence"
                ? uploadingExpiryEvidence
                : false)
        }
        title={
          photoMenuTarget === "optional"
            ? "Optional item photo"
            : photoMenuTarget === "expiry_evidence"
              ? "Expiry date photo"
              : "Issue evidence photo"
        }
      />
    </div>
  );
}
