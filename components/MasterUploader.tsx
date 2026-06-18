"use client";

/**
 * Supabase-backed evidence uploader — same interaction model as {@link SmartCameraUpload}
 * (capture controls first, thumbnails directly below). Uploads to the `media` bucket and
 * stores public URLs (no local-only File state).
 *
 * `variant="compact"` (operator / mobile): tap the card to open a bottom action sheet with
 * camera vs file browse; no large inline buttons on the card.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Webcam from "react-webcam";
import {
  Camera,
  CheckCircle2,
  FlipHorizontal,
  ImagePlus,
  Loader2,
  Upload,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { ScannerPhotoLightbox } from "@/components/scanner/ScannerPhotoLightbox";
import { SCANNER_PHOTO_MAX_HELPER } from "@/lib/scanner/scanner-photo-section-limit";
import { uploadToMedia, uploadToMediaAligned } from "../lib/supabase/storage";
import { isUuidString } from "../lib/uuid";

export type MasterUploaderVariant = "legacy" | "compact";

export type MasterUploaderAlignedUpload = {
  bucket: "media" | "manifests";
  /** Path after `{organization_id}/` — built with {@link ../lib/storage-helpers}. */
  relativePathUnderOrg: string;
};

export type MasterUploaderProps = {
  value: string[];
  onChange: (urls: string[]) => void;
  organizationId: string;
  maxFiles?: number;
  disabled?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** `compact` = tap card → bottom sheet (camera / browse); `legacy` = inline buttons. */
  variant?: MasterUploaderVariant;
  /**
   * `dense` = tighter padding, smaller thumbnails, title + count on one row (compact only).
   */
  compactDensity?: "default" | "dense";
  /**
   * When `false`, hides the “Tap to add photos” line in the empty compact card (e.g. when another slot is “active” first).
   */
  compactShowTapSubtitle?: boolean;
  /** Compact header only — hide trailing add icon once photos exist (Add photo row remains). */
  compactOmitHeaderAddIconWhenFilled?: boolean;
  /**
   * When set, new uploads use aligned `{org}/{store}/pallets|packages/...` paths.
   * Omit for legacy `{org}/incident/...` behavior (existing workflows).
   */
  alignedUpload?: MasterUploaderAlignedUpload | null;
  /**
   * Read-only gallery (e.g. saved box before “Edit All”): block uploads/removes without dimming the
   * whole card. Thumbnail delete controls are not mounted (`display` does not apply — nothing in DOM);
   * {@link removeAt} also consults a ref so late clicks cannot remove after lock engages.
   */
  viewLocked?: boolean;
  /** When true, thumbnail tap opens an in-app lightbox (no new tab / route). Default true. */
  inAppPreview?: boolean;
  /** Return false to block opening the add-photo sheet (camera / file picker). */
  onBeforeAdd?: () => boolean;
};

function primaryLabelContent(label: ReactNode | undefined, fallback: string): ReactNode {
  if (label == null || label === false) return fallback;
  if (typeof label === "string") {
    const t = label.trim();
    return t.length > 0 ? t : fallback;
  }
  return label;
}

function hintProvided(hint: ReactNode | undefined): boolean {
  if (hint == null || hint === false) return false;
  if (typeof hint === "string") return hint.trim().length > 0;
  return true;
}

async function base64ToFile(dataUrl: string, name: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image."));
    };
    img.src = url;
  });
}

async function compressImageFile(file: File, maxWidth = 1200): Promise<File> {
  const image = await loadImageFromFile(file);
  const srcW = Math.max(1, image.naturalWidth || image.width);
  const srcH = Math.max(1, image.naturalHeight || image.height);
  const targetW = Math.min(srcW, maxWidth);
  const scale = targetW / srcW;
  const targetH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(image, 0, 0, targetW, targetH);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.82),
  );
  if (!blob) return file;
  const outName = file.name.replace(/\.[^.]+$/, "") || `photo-${Date.now()}`;
  return new File([blob], `${outName}.jpg`, { type: "image/jpeg" });
}

export function MasterUploader({
  value,
  onChange,
  organizationId,
  maxFiles = 3,
  disabled = false,
  label = "Photos",
  hint = "Tap to capture or use desktop webcam / files — images upload automatically.",
  className = "",
  variant = "legacy",
  compactDensity = "default",
  compactShowTapSubtitle = true,
  compactOmitHeaderAddIconWhenFilled = false,
  alignedUpload = null,
  viewLocked = false,
  inAppPreview = true,
  onBeforeAdd,
}: MasterUploaderProps) {
  /** Latest `viewLocked` for handlers (avoids removes if the UI unmounts the button one frame late). */
  const viewLockedRef = useRef(viewLocked);
  viewLockedRef.current = viewLocked;

  const [isMobile, setIsMobile] = useState(true);
  const [webcamActive, setWebcamActive] = useState(false);
  const [webcamError, setWebcamError] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const mobileInputRef = useRef<HTMLInputElement>(null);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const compactCameraInputRef = useRef<HTMLInputElement>(null);
  const compactBrowseInputRef = useRef<HTMLInputElement>(null);
  const webcamRef = useRef<Webcam>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const uploadingRef = useRef(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetStep, setSheetStep] = useState<"menu" | "webcam">("menu");
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const mobile =
      navigator.maxTouchPoints > 1 || /Mobi|Android|iPhone|iPad|PDA/i.test(navigator.userAgent);
    setIsMobile(mobile);
  }, []);

  useEffect(() => {
    if (variant !== "compact" || !sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [variant, sheetOpen]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSheetOpen(false);
        setSheetStep("menu");
        setWebcamActive(false);
        setWebcamError(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const previewLabel = useMemo(() => {
    const raw = primaryLabelContent(label, "Photo");
    return typeof raw === "string" ? raw : "Photo";
  }, [label]);

  const openPreviewAt = useCallback(
    (index: number) => {
      if (!inAppPreview || !value[index]) return;
      setLightboxIdx(index);
    },
    [inAppPreview, value],
  );
  const canAdd = value.length < maxFiles && !disabled && !viewLocked;
  const isComplete = value.length > 0;
  const accentClass = "border-slate-300 dark:border-slate-700";

  const runUpload = useCallback(
    async (files: File[]) => {
      if (disabled || viewLockedRef.current || uploadingRef.current) return;
      const org = organizationId?.trim() ?? "";
      if (!isUuidString(org)) {
        setError("Missing or invalid organization — cannot upload.");
        return;
      }
      const list = files.filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) {
        setError("Choose image files only.");
        return;
      }
      const room = maxFiles - valueRef.current.length;
      const batch = list.slice(0, Math.max(0, room));
      if (batch.length === 0) return;
      setError("");
      uploadingRef.current = true;
      setUploading(true);
      const next = [...valueRef.current];
      try {
        for (const file of batch) {
          const compressed = await compressImageFile(file, 1200);
          const url =
            alignedUpload?.relativePathUnderOrg && alignedUpload.bucket
              ? await uploadToMediaAligned(compressed, org, {
                  bucket: alignedUpload.bucket,
                  relativePathUnderOrg: alignedUpload.relativePathUnderOrg,
                })
              : await uploadToMedia(compressed, "incident", org);
          next.push(url);
        }
        valueRef.current = next;
        onChangeRef.current(next);
        setSheetOpen(false);
        setSheetStep("menu");
        setWebcamActive(false);
        setWebcamError(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        uploadingRef.current = false;
        setUploading(false);
      }
    },
    [disabled, maxFiles, organizationId, alignedUpload],
  );

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (list?.length) void runUpload(Array.from(list));
    e.target.value = "";
  }

  function removeAt(i: number) {
    if (disabled || viewLockedRef.current || uploadingRef.current) return;
    const next = value.filter((_, idx) => idx !== i);
    valueRef.current = next;
    onChangeRef.current(next);
  }

  const captureFromWebcam = useCallback(async () => {
    const screenshot = webcamRef.current?.getScreenshot();
    if (!screenshot) return;
    try {
      const file = await base64ToFile(screenshot, `webcam-${Date.now()}.jpg`);
      await runUpload([file]);
      setWebcamActive(false);
    } catch {
      /* ignore */
    }
  }, [runUpload]);

  const openSheet = useCallback(() => {
    if (!canAdd || uploadingRef.current) return;
    if (onBeforeAdd && !onBeforeAdd()) return;
    setError("");
    setSheetStep("menu");
    setWebcamError(false);
    setSheetOpen(true);
  }, [canAdd, onBeforeAdd]);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    setSheetStep("menu");
    setWebcamActive(false);
    setWebcamError(false);
  }, []);

  const handleCompactTakePhoto = useCallback(() => {
    if (isMobile) {
      setSheetOpen(false);
      setSheetStep("menu");
      window.setTimeout(() => compactCameraInputRef.current?.click(), 0);
    } else {
      setSheetStep("webcam");
      setWebcamError(false);
    }
  }, [isMobile]);

  const handleCompactBrowse = useCallback(() => {
    setSheetOpen(false);
    setSheetStep("menu");
    window.setTimeout(() => compactBrowseInputRef.current?.click(), 0);
  }, []);

  if (variant === "compact") {
    const dense = compactDensity === "dense";
    const padRow = dense ? "px-2 py-1.5" : "px-3 py-3";
    const padRowMin = dense ? "" : "min-h-[4.5rem]";
    const padHeader = dense ? "px-2 py-1.5" : "px-3 py-2.5";
    const icoBox = dense ? "h-6 w-6 rounded-md" : "h-8 w-8 rounded-lg";
    const icoSm = dense ? "h-3.5 w-3.5" : "h-4 w-4";
    const titleCls = dense
      ? "min-w-0 flex-1 truncate text-[11px] font-semibold leading-tight text-slate-900 dark:text-slate-50"
      : "min-w-0 flex-1 text-sm font-semibold leading-tight text-slate-900 dark:text-slate-50";
    const countCls = dense
      ? "shrink-0 text-[10px] font-bold tabular-nums text-slate-500 dark:text-slate-400"
      : "shrink-0 text-xs font-bold tabular-nums text-slate-500 dark:text-slate-400";
    const thumbGrid = compactOmitHeaderAddIconWhenFilled
      ? "master-uploader-slip-thumb-row flex flex-wrap items-start gap-2 px-2 pb-1.5 pt-1"
      : dense
        ? "grid grid-cols-5 gap-1.5 px-2 pb-1.5 pt-1"
        : "grid grid-cols-4 gap-2 px-3 pb-2 pt-2";
    const thumbRadius = dense ? "rounded-lg" : "rounded-xl";
    const rmBtn = dense ? "right-0.5 top-0.5 h-5 w-5" : "right-1 top-1 h-6 w-6";
    const rmIcon = dense ? "h-3 w-3" : "h-3.5 w-3.5";
    const showTapLine = compactShowTapSubtitle && value.length === 0;

    return (
      <div className={`space-y-0 ${className}`}>
        <div
          className={[
            "overflow-hidden border-2 bg-white transition dark:bg-slate-900",
            dense ? "rounded-xl" : "rounded-2xl",
            isComplete ? "border-emerald-400 dark:border-emerald-600/60" : accentClass,
            disabled && !viewLocked ? "pointer-events-none opacity-45" : "",
            viewLocked ? "select-none" : "",
          ].join(" ")}
        >
          {value.length === 0 && canAdd ? (
            <button
              type="button"
              onClick={openSheet}
              className={[
                "flex w-full items-center gap-2 text-left transition hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-slate-800/50",
                padRow,
                padRowMin,
              ].join(" ")}
            >
              <div
                className={`flex shrink-0 items-center justify-center bg-slate-100 dark:bg-slate-800 ${icoBox}`}
              >
                <Camera className={`${icoSm} text-slate-500 dark:text-slate-400`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className={titleCls}>{primaryLabelContent(label, "Evidence")}</p>
                  <span className={countCls}>
                    {value.length}/{maxFiles}
                  </span>
                </div>
                {showTapLine ? (
                  dense ? (
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <ImagePlus className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden />
                      <p className="text-[9px] leading-tight text-slate-500 dark:text-slate-400">Tap to add photos</p>
                    </div>
                  ) : (
                    <p className="mt-0.5 text-[10px] leading-tight text-slate-500 dark:text-slate-400">Tap to add photos</p>
                  )
                ) : null}
              </div>
              {dense ? (
                <ImagePlus className={`${icoSm} shrink-0 text-slate-400 dark:text-slate-500`} aria-hidden />
              ) : (
                <span className="shrink-0 rounded-md border border-slate-200 bg-slate-50 p-1 dark:border-slate-600 dark:bg-slate-800">
                  <ImagePlus className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
                </span>
              )}
            </button>
          ) : value.length === 0 ? (
            <div className={`flex w-full items-center gap-2 opacity-60 ${padRow} ${padRowMin}`}>
              <div
                className={`flex shrink-0 items-center justify-center bg-slate-100 dark:bg-slate-800 ${icoBox}`}
              >
                <Camera className={`${icoSm} text-slate-500 dark:text-slate-400`} />
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <p className={titleCls}>{primaryLabelContent(label, "Evidence")}</p>
                <span className={countCls}>0/{maxFiles}</span>
              </div>
            </div>
          ) : compactOmitHeaderAddIconWhenFilled ? (
            <div
              className={`master-uploader-slip-filled-header flex flex-nowrap items-center gap-2 border-b border-slate-200 dark:border-slate-800 ${padHeader}`}
            >
              <div
                className={[
                  `flex shrink-0 items-center justify-center ${icoBox}`,
                  isComplete ? "bg-emerald-100 dark:bg-emerald-950/40" : "bg-slate-100 dark:bg-slate-800",
                ].join(" ")}
              >
                {isComplete ? (
                  <CheckCircle2 className={`${icoSm} text-emerald-600 dark:text-emerald-400`} />
                ) : (
                  <Camera className={`${icoSm} text-slate-500 dark:text-slate-400`} />
                )}
              </div>
              <p className="min-w-0 flex-1 truncate text-[11px] font-semibold leading-tight text-slate-900 dark:text-slate-50">
                {primaryLabelContent(label, "Evidence")}
              </p>
              <span className={countCls}>
                {value.length}/{maxFiles}
              </span>
            </div>
          ) : (
            <div
              className={`flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 ${padHeader}`}
            >
              <div
                className={[
                  `flex shrink-0 items-center justify-center ${icoBox}`,
                  isComplete ? "bg-emerald-100 dark:bg-emerald-950/40" : "bg-slate-100 dark:bg-slate-800",
                ].join(" ")}
              >
                {isComplete ? (
                  <CheckCircle2 className={`${icoSm} text-emerald-600 dark:text-emerald-400`} />
                ) : (
                  <Camera className={`${icoSm} text-slate-500 dark:text-slate-400`} />
                )}
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <p className={titleCls}>{primaryLabelContent(label, "Evidence")}</p>
                <span className={countCls}>
                  {value.length}/{maxFiles}
                </span>
              </div>
              {canAdd && !(compactOmitHeaderAddIconWhenFilled && value.length > 0) ? (
                dense ? (
                  <ImagePlus className={`${icoSm} shrink-0 text-slate-400 dark:text-slate-500`} aria-hidden />
                ) : (
                  <span className="shrink-0 rounded-md border border-slate-200 bg-slate-50 p-1 dark:border-slate-600 dark:bg-slate-800">
                    <ImagePlus className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
                  </span>
                )
              ) : null}
            </div>
          )}

          {value.length > 0 && (
            <div className={thumbGrid}>
              {value.map((url, i) => (
                <div
                  key={`${url}-${i}`}
                  className={`relative aspect-square overflow-hidden border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800 ${thumbRadius}`}
                >
                  {inAppPreview ? (
                    <button
                      type="button"
                      className="h-full w-full"
                      onClick={() => openPreviewAt(i)}
                      aria-label={`Preview photo ${i + 1}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" className="h-full w-full object-contain" />
                    </button>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={url} alt="" className="h-full w-full object-contain" />
                  )}
                  {!viewLocked ? (
                    <button
                      type="button"
                      disabled={disabled || uploading}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeAt(i);
                      }}
                      className={`absolute z-[1] flex items-center justify-center rounded-full bg-black/70 text-white shadow-md transition hover:bg-rose-600 disabled:pointer-events-none disabled:opacity-40 ${rmBtn}`}
                      aria-label="Remove photo"
                    >
                      <X className={rmIcon} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {canAdd && value.length > 0 && !uploading ? (
            <button
              type="button"
              onClick={openSheet}
              className={[
                "flex w-full items-center justify-center border-t border-slate-200 font-semibold text-sky-600 transition hover:bg-slate-50 active:bg-slate-100 dark:border-slate-800 dark:text-sky-400 dark:hover:bg-slate-800/60",
                dense ? "gap-1.5 py-1.5 text-[10px]" : "gap-2 py-2 text-[11px]",
              ].join(" ")}
            >
              <ImagePlus className={dense ? "h-3 w-3 shrink-0" : "h-3.5 w-3.5"} />
              Add photo <span className="tabular-nums opacity-90">({value.length}/{maxFiles})</span>
            </button>
          ) : null}

          {uploading && (
            <div
              className={`flex items-center gap-2 text-slate-600 dark:text-slate-300 ${dense ? "px-2 py-2 text-xs font-medium" : "px-3 py-3 text-sm font-medium"}`}
            >
              <Loader2 className={`${dense ? "h-4 w-4" : "h-5 w-5"} shrink-0 animate-spin text-sky-500`} />
              Uploading…
            </div>
          )}

          <input
            ref={compactCameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={compactBrowseInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {hintProvided(hint) ? (
          <p className="mt-1 px-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">{hint}</p>
        ) : null}
        {maxFiles === 3 ? (
          <p className="mt-1 px-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">{SCANNER_PHOTO_MAX_HELPER}</p>
        ) : null}

        {error ? (
          <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        {sheetOpen && typeof document !== "undefined"
          ? createPortal(
              <>
                <div
                  className="scanner-photo-action-sheet-backdrop"
                  role="presentation"
                  onClick={closeSheet}
                />
                {sheetStep === "menu" ? (
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Add photo"
                    className="scanner-photo-action-sheet-panel scanner-ocr-action-sheet"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="scanner-photo-action-sheet-handle" aria-hidden />
                    <p className="scanner-photo-action-sheet-title">Add photo</p>
                    <div className="scanner-photo-action-sheet-options">
                      <button
                        type="button"
                        disabled={uploading}
                        className="scanner-photo-action-sheet-option"
                        onClick={handleCompactTakePhoto}
                      >
                        <span className="scanner-photo-action-sheet-option-icon" aria-hidden>
                          📷
                        </span>
                        Take photo
                      </button>
                      <button
                        type="button"
                        disabled={uploading}
                        className="scanner-photo-action-sheet-option scanner-photo-action-sheet-option--border"
                        onClick={handleCompactBrowse}
                      >
                        <span className="scanner-photo-action-sheet-option-icon" aria-hidden>
                          📁
                        </span>
                        Upload photo
                      </button>
                      <button
                        type="button"
                        className="scanner-photo-action-sheet-option scanner-photo-action-sheet-option--cancel scanner-photo-action-sheet-option--border"
                        onClick={closeSheet}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Camera capture"
                    className="scanner-photo-action-sheet-panel scanner-photo-action-sheet-panel--webcam"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="relative overflow-hidden rounded-xl bg-slate-950">
                      {webcamError ? (
                        <div className="flex h-48 flex-col items-center justify-center gap-2 px-3">
                          <VideoOff className="h-8 w-8 text-slate-500" />
                          <p className="text-center text-xs text-slate-400">Camera unavailable</p>
                          <button
                            type="button"
                            onClick={() => {
                              setSheetStep("menu");
                              setWebcamActive(false);
                              setWebcamError(false);
                            }}
                            className="text-xs text-sky-400 underline"
                          >
                            Back
                          </button>
                        </div>
                      ) : (
                        <Webcam
                          ref={webcamRef}
                          audio={false}
                          screenshotFormat="image/jpeg"
                          screenshotQuality={0.92}
                          videoConstraints={{ facingMode, width: 1280, height: 720 }}
                          onUserMediaError={() => setWebcamError(true)}
                          className="w-full"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSheetStep("menu");
                          setWebcamActive(false);
                          setWebcamError(false);
                        }}
                        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:bg-black/80"
                        aria-label="Close camera"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void captureFromWebcam()}
                        disabled={webcamError || uploading}
                        className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 py-2.5 text-sm font-bold text-white transition hover:bg-sky-400 disabled:opacity-50"
                      >
                        <Camera className="h-4 w-4" /> Capture &amp; upload
                      </button>
                      <button
                        type="button"
                        onClick={() => setFacingMode((m) => (m === "environment" ? "user" : "environment"))}
                        title="Flip camera"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        <FlipHorizontal className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>,
              document.body,
            )
          : null}

        {inAppPreview && lightboxIdx !== null && typeof document !== "undefined" ? (
          <ScannerPhotoLightbox
            photos={value.map((src) => ({ src, label: previewLabel }))}
            startIdx={lightboxIdx}
            onClose={() => setLightboxIdx(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={`space-y-0 ${className}`}>
      <div
        className={[
          "overflow-hidden rounded-2xl border-2 bg-white transition dark:bg-slate-900",
          isComplete ? "border-emerald-400 dark:border-emerald-600/60" : accentClass,
        ].join(" ")}
      >
        <div className="flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div
            className={[
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              isComplete ? "bg-emerald-100 dark:bg-emerald-950/40" : "bg-slate-100 dark:bg-slate-800",
            ].join(" ")}
          >
            {isComplete ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Camera className="h-5 w-5 text-slate-500 dark:text-slate-400" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {primaryLabelContent(label, "Evidence")}
            </p>
            {hintProvided(hint) ? (
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">{hint}</p>
            ) : null}
          </div>
          <span className="shrink-0 text-xs font-bold text-slate-500 dark:text-slate-400">
            {value.length}/{maxFiles}
          </span>
        </div>

        {canAdd && !uploading && (
          <>
            {isMobile && (
              <button
                type="button"
                disabled={!canAdd}
                onClick={() => mobileInputRef.current?.click()}
                className="flex w-full items-center gap-4 px-4 py-4 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800/60"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
                  <Camera className="h-5 w-5 text-slate-500 dark:text-slate-400" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {value.length === 0 ? "Tap to Capture" : "Add Another Photo"}
                  </p>
                  <p className="text-[11px] text-slate-400">Opens rear camera directly · no file picker</p>
                </div>
              </button>
            )}

            {!isMobile && webcamActive && (
              <div className="p-3">
                <div className="relative overflow-hidden rounded-xl bg-slate-950">
                  {webcamError ? (
                    <div className="flex h-44 flex-col items-center justify-center gap-2">
                      <VideoOff className="h-8 w-8 text-slate-500" />
                      <p className="text-xs text-slate-400">Camera access denied or unavailable</p>
                      <button
                        type="button"
                        onClick={() => {
                          setWebcamActive(false);
                          setWebcamError(false);
                        }}
                        className="mt-1 text-xs text-sky-400 underline"
                      >
                        Use file upload instead
                      </button>
                    </div>
                  ) : (
                    <Webcam
                      ref={webcamRef}
                      audio={false}
                      screenshotFormat="image/jpeg"
                      screenshotQuality={0.92}
                      videoConstraints={{ facingMode, width: 1280, height: 720 }}
                      onUserMediaError={() => setWebcamError(true)}
                      className="w-full"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setWebcamActive(false);
                      setWebcamError(false);
                    }}
                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:bg-black/80"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void captureFromWebcam()}
                    disabled={webcamError}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 py-2.5 text-sm font-bold text-white transition hover:bg-sky-400 active:scale-[0.98] disabled:opacity-50"
                  >
                    <Camera className="h-4 w-4" /> Capture &amp; Upload
                  </button>
                  <button
                    type="button"
                    onClick={() => setFacingMode((m) => (m === "environment" ? "user" : "environment"))}
                    title="Flip camera"
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    <FlipHorizontal className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {!isMobile && !webcamActive && (
              <div className="flex gap-2 p-3">
                <button
                  type="button"
                  onClick={() => {
                    setWebcamError(false);
                    setWebcamActive(true);
                  }}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60"
                >
                  <Video className="h-4 w-4" />
                  {value.length === 0 ? "Use Webcam" : "Add via Webcam"}
                </button>
                <button
                  type="button"
                  onClick={() => desktopInputRef.current?.click()}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60"
                >
                  <Upload className="h-4 w-4" />
                  {value.length === 0 ? "Browse Files" : "Add More Files"}
                </button>
              </div>
            )}
          </>
        )}

        {uploading && (
          <div className="flex items-center gap-2 px-4 py-4 text-sm font-medium text-slate-600 dark:text-slate-300">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-sky-500" />
            Uploading…
          </div>
        )}

        <input
          ref={mobileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={desktopInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        {value.length > 0 && (
          <div className="grid grid-cols-4 gap-2 px-4 pb-3 pt-2">
            {value.map((url, i) => (
              <div
                key={`${url}-${i}`}
                className="relative aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
              >
                {inAppPreview ? (
                  <button
                    type="button"
                    className="h-full w-full"
                    onClick={() => openPreviewAt(i)}
                    aria-label={`Preview photo ${i + 1}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="h-full w-full object-contain" />
                  </button>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={url} alt="" className="h-full w-full object-contain" />
                )}
                {!viewLocked ? (
                  <button
                    type="button"
                    disabled={disabled || uploading}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeAt(i);
                    }}
                    className="absolute right-1 top-1 z-[1] flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white shadow-md transition hover:bg-rose-600 disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Remove photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {error ? (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {inAppPreview && lightboxIdx !== null && typeof document !== "undefined" ? (
        <ScannerPhotoLightbox
          photos={value.map((src) => ({ src, label: previewLabel }))}
          startIdx={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      ) : null}
    </div>
  );
}

/** Operator-style tap → action sheet; same behavior as `<MasterUploader variant="compact" />`. */
export function PhotoUploadCard(props: Omit<MasterUploaderProps, "variant">) {
  return <MasterUploader variant="compact" {...props} />;
}
