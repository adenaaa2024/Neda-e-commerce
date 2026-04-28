"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUserRole } from "@/components/UserRoleContext";
import { listStores, type StorePublicRow } from "@/app/settings/adapters/actions";
import {
  createPackage,
  createPallet,
  insertReturn,
  listPackages,
  listPallets,
  updatePackage,
} from "@/app/returns/actions";
import type { PackageRecord, PalletRecord } from "@/app/returns/returns-action-types";
import type { TenantQueryOpts } from "@/lib/server-tenant";
import { resolveOrganizationId } from "@/lib/organization";
import { isUuidString } from "@/lib/uuid";
import { isSupabaseConfigured, supabase } from "@/src/lib/supabase";
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  Boxes,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileWarning,
  HelpCircle,
  Package,
  Plus,
  ShieldAlert,
  Redo2,
  ScanLine,
  XCircle,
} from "lucide-react";

type ScanResultLine = { id: string; at: string; text: string };
/** For feed styling; derived from `text` at render time so scan logic stays unchanged. */
type ResultTone = "success" | "warning" | "error" | "neutral";

type EntryMode = null | "pallet" | "box" | "item" | "continue";

type PalletSessionStep =
  | "scan_pallet"
  | "set_expected_packages"
  | "scan_packages"
  | "set_package_expected_items"
  | "scan_items";
type BoxSessionStep = "scan_package" | "set_expected_items" | "scan_items";
type PackageLookupState = {
  scannedValue: string;
  /** Any row(s) in `expected_packages` for this scan. */
  matchedExpected: boolean;
  /** Matched an existing package in `packages`. */
  matchedExistingPackage: boolean;
};

function newResultLine(text: string): ScanResultLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    text,
  };
}

function inferResultTone(text: string): ResultTone {
  const t = text.toLowerCase();
  if (t.startsWith("warning:") || t.includes("warning:")) return "warning";
  if (t.includes(" not recorded") || t.includes("not recorded")) return "warning";
  if (t.includes("error") || t.startsWith("error")) return "error";
  if (
    t.includes("— success") ||
    t.includes("success") ||
    t.includes("recorded") ||
    t.includes("created") ||
    t.includes("selected") ||
    t === "pallet selected" ||
    t === "box selected" ||
    t.includes("closed") ||
    t.includes("already exists") ||
    t.includes("existing pallet") ||
    t.includes("existing package") ||
    t.includes("matched expected")
  ) {
    return "success";
  }
  return "neutral";
}

function normalizeScanCompare(s: string): string {
  return s.trim().toLowerCase();
}

function palletMatchesScan(row: PalletRecord, scan: string): boolean {
  const n = normalizeScanCompare(scan);
  return (
    normalizeScanCompare(row.pallet_number) === n ||
    (!!row.tracking_number && normalizeScanCompare(row.tracking_number) === n)
  );
}

function packageMatchesScan(row: PackageRecord, scan: string): boolean {
  const n = normalizeScanCompare(scan);
  return (
    normalizeScanCompare(row.package_number) === n ||
    (!!row.tracking_number && normalizeScanCompare(row.tracking_number) === n)
  );
}

async function fetchExpectedPackagesForOrg(
  organizationId: string,
  scan: string,
): Promise<unknown[]> {
  if (!isSupabaseConfigured() || !scan.trim()) return [];
  const t = scan.trim();
  const base = () =>
    supabase.from("expected_packages").select("id").eq("organization_id", organizationId);
  try {
    const { data: byTrack, error: e1 } = await base().eq("tracking_number", t).limit(40);
    if (e1) throw e1;
    const rows = [...((byTrack ?? []) as { id?: string }[])];
    const { data: byAlloc, error: e2 } = await base().eq("allocation_box_code", t).limit(40);
    if (e2) throw e2;
    const ids = new Set(rows.map((r) => String(r?.id ?? "")));
    for (const r of (byAlloc ?? []) as { id?: string }[]) {
      if (r?.id && !ids.has(String(r.id))) {
        ids.add(String(r.id));
        rows.push(r);
      }
    }
    return rows;
  } catch {
    return [];
  }
}

const toneRowClass: Record<ResultTone, string> = {
  success:
    "border-l-4 border-l-emerald-500 bg-emerald-950/25 dark:bg-emerald-950/20 text-foreground",
  warning:
    "border-l-4 border-l-amber-500 bg-amber-950/30 dark:bg-amber-950/20 text-foreground",
  error: "border-l-4 border-l-red-500 bg-red-950/30 dark:bg-red-950/20 text-foreground",
  neutral: "border-l-4 border-l-border bg-muted/20 text-foreground",
};

export default function OperatorScannerPage() {
  const {
    organizationId: workspaceOrganizationId,
    actorUserId,
    actorName,
    role,
  } = useUserRole();

  const effectiveOrganizationId = useMemo(() => {
    const oid = workspaceOrganizationId?.trim();
    if (oid && isUuidString(oid)) return oid;
    return resolveOrganizationId();
  }, [workspaceOrganizationId]);

  const listTenantOpts = useMemo((): TenantQueryOpts => {
    const filterOrganizationId =
      role === "super_admin" ? effectiveOrganizationId : null;
    return {
      actorProfileId: actorUserId ?? null,
      ...(filterOrganizationId ? { filterOrganizationId } : {}),
    };
  }, [actorUserId, role, effectiveOrganizationId]);

  const writeOrgPayload = useMemo(
    () => ({ actor_profile_id: actorUserId ?? null, organization_id: effectiveOrganizationId }),
    [actorUserId, effectiveOrganizationId],
  );

  const [storesList, setStoresList] = useState<StorePublicRow[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesLoadError, setStoresLoadError] = useState<string | null>(null);

  const storesForOrganization = useMemo(() => {
    return storesList.filter(
      (s) => s.organization_id === effectiveOrganizationId && s.is_active === true,
    );
  }, [storesList, effectiveOrganizationId]);

  const [mode, setMode] = useState<EntryMode>(null);
  const [palletStep, setPalletStep] = useState<PalletSessionStep>("scan_pallet");
  const [boxStep, setBoxStep] = useState<BoxSessionStep>("scan_package");
  /** Display label — pallet_number or scanned value. */
  const [currentPallet, setCurrentPallet] = useState<string | null>(null);
  /** Persisted pallet row id — used for FK on packages / returns-derived context. */
  const [currentPalletRecordId, setCurrentPalletRecordId] = useState<string | null>(null);
  const [currentBox, setCurrentBox] = useState<string | null>(null);
  /** Persisted package row id when linked to DB. */
  const [currentPackageRecordId, setCurrentPackageRecordId] = useState<string | null>(null);
  const [persistBusy, setPersistBusy] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [scanResults, setScanResults] = useState<ScanResultLine[]>([]);
  const [palletExpectedPackagesInput, setPalletExpectedPackagesInput] = useState<string>("");
  const [palletScannedPackages, setPalletScannedPackages] = useState<number>(0);
  const [packageExpectedItemsInput, setPackageExpectedItemsInput] = useState<string>("");
  const [packageScannedItems, setPackageScannedItems] = useState<number>(0);
  const [palletCarrier, setPalletCarrier] = useState("UPS");
  /** Local UI only — maps to `stores.id` for the current organization. */
  const [palletStoreId, setPalletStoreId] = useState("");
  const [palletAmazonOrderId, setPalletAmazonOrderId] = useState("");
  const [palletNotes, setPalletNotes] = useState("");
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [scanFeedbackTone, setScanFeedbackTone] = useState<ResultTone | null>(null);
  const [scanFeedbackActive, setScanFeedbackActive] = useState(false);
  const [packageLookup, setPackageLookup] = useState<PackageLookupState | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const scanFormRef = useRef<HTMLFormElement>(null);

  const isScannerView = mode !== null;
  const showScanForm =
    isScannerView &&
    mode !== "continue" &&
    (mode === "item" ||
      (mode === "pallet" &&
        (palletStep === "scan_pallet" || palletStep === "scan_packages" || palletStep === "scan_items")) ||
      (mode === "box" && (boxStep === "scan_package" || boxStep === "scan_items")));

  const pushResult = useCallback((text: string) => {
    setScanResults((prev) => [newResultLine(text), ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStoresLoading(true);
    setStoresLoadError(null);
    void listStores(null)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.data) {
          setStoresList(res.data);
        } else {
          setStoresList([]);
          setStoresLoadError(res.ok === false ? res.error ?? "Failed to load stores" : "No store data");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStoresList([]);
          setStoresLoadError(e instanceof Error ? e.message : "Failed to load stores");
        }
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const classifyScannedValue = useCallback((value: string): ResultTone => {
    const t = value.toUpperCase();
    if (t.includes("ERR")) return "error";
    if (t.includes("WARN")) return "warning";
    return "success";
  }, []);

  const goHome = useCallback(() => {
    setMode(null);
    setPalletStep("scan_pallet");
    setBoxStep("scan_package");
    setCurrentPallet(null);
    setCurrentPalletRecordId(null);
    setCurrentBox(null);
    setCurrentPackageRecordId(null);
    setScanInput("");
    setPalletExpectedPackagesInput("");
    setPalletScannedPackages(0);
    setPackageExpectedItemsInput("");
    setPackageScannedItems(0);
    setPalletCarrier("UPS");
    setPalletStoreId("");
    setPalletAmazonOrderId("");
    setPalletNotes("");
    setScanResults([]);
    setPackageLookup(null);
  }, []);

  const goMode = useCallback((m: NonNullable<EntryMode>) => {
    setMode(m);
    setPalletStep("scan_pallet");
    setBoxStep("scan_package");
    setCurrentPallet(null);
    setCurrentPalletRecordId(null);
    setCurrentBox(null);
    setCurrentPackageRecordId(null);
    setScanInput("");
    setPalletExpectedPackagesInput("");
    setPalletScannedPackages(0);
    setPackageExpectedItemsInput("");
    setPackageScannedItems(0);
    setPalletCarrier("UPS");
    setPalletStoreId("");
    setPalletAmazonOrderId("");
    setPalletNotes("");
    setScanResults([]);
    setPackageLookup(null);
  }, []);

  const closeBox = useCallback(() => {
    if (mode !== "pallet" && mode !== "box") return;
    setCurrentBox(null);
    setCurrentPackageRecordId(null);
    setPackageExpectedItemsInput("");
    setPackageScannedItems(0);
    setPackageLookup(null);
    if (mode === "box") setBoxStep("scan_package");
    if (mode === "pallet") setPalletStep("scan_packages");
    pushResult("Box closed");
  }, [mode, pushResult]);

  const closePallet = useCallback(() => {
    setCurrentPallet(null);
    setCurrentPalletRecordId(null);
    setCurrentBox(null);
    setCurrentPackageRecordId(null);
    setPalletStep("scan_pallet");
    setPalletScannedPackages(0);
    setPalletExpectedPackagesInput("");
    setPackageExpectedItemsInput("");
    setPackageScannedItems(0);
    setPalletCarrier("UPS");
    setPalletStoreId("");
    setPalletAmazonOrderId("");
    setPalletNotes("");
    setPackageLookup(null);
    pushResult("Pallet closed");
  }, [pushResult]);

  useEffect(() => {
    if (showScanForm) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [showScanForm, mode]);

  const commitScan = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      if (mode === "pallet" && palletStep === "scan_pallet") {
        const listRes = await listPallets(listTenantOpts);
        if (!listRes.ok || !listRes.data) {
          pushResult(`Error: ${listRes.error ?? "Could not load pallets."}`);
          return;
        }
        let found = listRes.data.find((p) => palletMatchesScan(p, trimmed));

        if (found) {
          setCurrentPalletRecordId(found.id);
          setCurrentPallet(found.pallet_number.trim() || trimmed);
          setCurrentBox(null);
          setCurrentPackageRecordId(null);
          setPalletScannedPackages(0);
          setPalletStep("set_expected_packages");
          setPackageLookup(null);
          pushResult(`Existing pallet found — ${found.pallet_number}`);
          return;
        }

        const cr = await createPallet({
          pallet_number: trimmed,
          ...writeOrgPayload,
        });

        if (!cr.ok || !cr.data) {
          const msg =
            cr.error?.toLowerCase().includes("duplicate") || cr.error?.toLowerCase().includes("unique")
              ? `${cr.error} — Try another pallet number or refresh the list from /returns.`
              : cr.error ?? "Failed to create pallet.";
          pushResult(`Error: ${msg}`);
          return;
        }

        setCurrentPalletRecordId(cr.data.id);
        setCurrentPallet(cr.data.pallet_number.trim() || trimmed);
        setCurrentBox(null);
        setCurrentPackageRecordId(null);
        setPalletScannedPackages(0);
        setPalletStep("set_expected_packages");
        setPackageLookup(null);
        pushResult(`New pallet session — ${cr.data.pallet_number}`);
        return;
      }

      const isPkgScanStep =
        (mode === "pallet" && palletStep === "scan_packages") ||
        (mode === "box" && boxStep === "scan_package");

      if (isPkgScanStep) {
        const expectedRows = await fetchExpectedPackagesForOrg(effectiveOrganizationId, trimmed);
        const matchedExpected = expectedRows.length > 0;

        const listRes = await listPackages(listTenantOpts);
        if (!listRes.ok || !listRes.data) {
          pushResult(`Error: ${listRes.error ?? "Could not load packages."}`);
          return;
        }

        let pkgRow = listRes.data.find((p) => packageMatchesScan(p, trimmed));

        const palletFk = mode === "pallet" ? currentPalletRecordId : null;
        if (mode === "pallet" && !palletFk) {
          pushResult("Error: Pallet session is missing a saved pallet record. Scan pallet again.");
          return;
        }

        if (pkgRow) {
          setCurrentPackageRecordId(pkgRow.id);
          setCurrentBox(trimmed);
          setPackageScannedItems(0);
          setPackageExpectedItemsInput("");
          setPalletScannedPackages((n) => n + 1);
          if (mode === "pallet") setPalletStep("set_package_expected_items");
          else setBoxStep("set_expected_items");
          setPackageLookup({
            scannedValue: trimmed,
            matchedExpected,
            matchedExistingPackage: true,
          });
          pushResult("Existing package found");
          if (matchedExpected) pushResult("Matched expected package");
          pushResult(`Package / Box selected — ${trimmed}`);
          return;
        }

        const itemCountTrim = packageExpectedItemsInput.trim();
        const parsedItemDraft =
          itemCountTrim === ""
            ? 0
            : (() => {
                const n = Number.parseInt(itemCountTrim, 10);
                return Number.isFinite(n) && n >= 0 ? n : 0;
              })();

        const cr = await createPackage({
          package_number: trimmed,
          tracking_number: trimmed,
          pallet_id: palletFk ?? undefined,
          expected_item_count: parsedItemDraft,
          ...writeOrgPayload,
        });

        if (!cr.ok || !cr.data) {
          if (cr.error?.includes("tracking") || cr.error?.includes("duplicate")) {
            const r2 = await listPackages(listTenantOpts);
            if (r2.ok && r2.data) {
              const again = r2.data.find((p) => packageMatchesScan(p, trimmed));
              if (again) {
                setCurrentPackageRecordId(again.id);
                setCurrentBox(trimmed);
                setPackageScannedItems(0);
                setPackageExpectedItemsInput("");
                setPalletScannedPackages((n) => n + 1);
                if (mode === "pallet") setPalletStep("set_package_expected_items");
                else setBoxStep("set_expected_items");
                setPackageLookup({
                  scannedValue: trimmed,
                  matchedExpected,
                  matchedExistingPackage: true,
                });
                pushResult(cr.error ?? "Duplicate resolved — linking existing package");
                pushResult(`Existing package found — ${trimmed}`);
                return;
              }
            }
          }
          pushResult(`Error: ${cr.error ?? "Failed to create package."}`);
          return;
        }

        setCurrentPackageRecordId(cr.data.id);
        setCurrentBox(trimmed);
        setPackageScannedItems(0);
        setPackageExpectedItemsInput("");
        setPalletScannedPackages((n) => n + 1);
        if (mode === "pallet") setPalletStep("set_package_expected_items");
        else setBoxStep("set_expected_items");
        setPackageLookup({
          scannedValue: trimmed,
          matchedExpected,
          matchedExistingPackage: false,
        });
        pushResult(`Package created — ${trimmed}`);
        if (matchedExpected) pushResult("Matched expected package");
        else pushResult("Warning: Package not found in expected data — new package created");
        return;
      }

      const isItemScan =
        (mode === "pallet" && palletStep === "scan_items") ||
        (mode === "box" && boxStep === "scan_items") ||
        mode === "item";

      if (isItemScan) {
        setPackageLookup(null);
        let packageIdForReturn: string | null = null;

        if (mode === "pallet" || mode === "box") {
          packageIdForReturn = currentPackageRecordId;
          if (!packageIdForReturn) {
            pushResult("Error: No package linked — finish package scan before item scans.");
            return;
          }
        }

        const scanTone = classifyScannedValue(trimmed);

        const ir = await insertReturn({
          marketplace: "amazon",
          item_name: trimmed || "Unidentified item",
          conditions: ["received"],
          ...(packageIdForReturn ? { package_id: packageIdForReturn } : {}),
          ...writeOrgPayload,
        });

        if (!ir.ok || !ir.data) {
          const friendly =
            ir.error?.toLowerCase().includes("duplicate") || ir.error?.toLowerCase().includes("lpn")
              ? ir.error ?? "Duplicate item — identifier may already exist."
              : ir.error ?? "Failed to save item.";
          pushResult(`Error: ${friendly}`);
          return;
        }

        if (scanTone === "error") {
          pushResult(`Note: scanned value flagged error — recorded anyway — ${trimmed}`);
        } else if (scanTone === "warning") {
          pushResult(`Note: flagged unexpected scan — recorded — ${trimmed}`);
        } else {
          pushResult(`Item recorded — ${trimmed} — success`);
        }
        if (mode === "pallet" || mode === "box") {
          setPackageScannedItems((n) => n + 1);
        }
        return;
      }

      pushResult("Complete required step first.");
    },
    [
      mode,
      palletStep,
      boxStep,
      listTenantOpts,
      effectiveOrganizationId,
      currentPalletRecordId,
      currentPackageRecordId,
      packageExpectedItemsInput,
      writeOrgPayload,
      pushResult,
      classifyScannedValue,
    ],
  );

  const onScanSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (mode == null || mode === "continue" || persistBusy) return;
      const raw = scanInput.trim();
      if (!raw) return;

      setScanInput("");
      setPersistBusy(true);
      void commitScan(raw)
        .catch((err) => {
          console.error("[operator-scan]", err);
          pushResult(
            `Error: ${err instanceof Error ? err.message : "Something went wrong."}`,
          );
        })
        .finally(() => {
          setPersistBusy(false);
          setTimeout(() => inputRef.current?.focus(), 0);
        });
    },
    [mode, scanInput, persistBusy, commitScan, pushResult],
  );

  const { modeLabel, stepLabel } = useMemo(() => {
    if (mode == null) {
      return { modeLabel: "—", stepLabel: "—" };
    }
    if (mode === "continue") {
      return { modeLabel: "Continue Existing", stepLabel: "Lookup" };
    }
    if (mode === "item") {
      return { modeLabel: "Loose item receiving", stepLabel: "Scan items" };
    }
    if (mode === "box") {
      if (boxStep === "scan_package") return { modeLabel: "Package / box receiving", stepLabel: "Scan package" };
      if (boxStep === "set_expected_items") return { modeLabel: "Package / box receiving", stepLabel: "Set expected items" };
      return { modeLabel: "Package / box receiving", stepLabel: "Scan items" };
    }
    if (mode === "pallet") {
      if (palletStep === "scan_pallet") return { modeLabel: "Pallet receiving", stepLabel: "Scan pallet" };
      if (palletStep === "set_expected_packages") return { modeLabel: "Pallet receiving", stepLabel: "Set expected packages" };
      if (palletStep === "scan_packages") return { modeLabel: "Pallet receiving", stepLabel: "Scan packages" };
      if (palletStep === "set_package_expected_items") return { modeLabel: "Pallet receiving", stepLabel: "Set package expected items" };
      return { modeLabel: "Pallet receiving", stepLabel: "Scan items" };
    }
    return { modeLabel: "—", stepLabel: "—" };
  }, [mode, palletStep, boxStep]);

  const nextScanLabel = useMemo(() => {
    if (mode === "pallet" && palletStep === "scan_pallet") return "Next scan: Scan pallet tracking / pallet label";
    if (mode === "pallet" && palletStep === "scan_packages") return "Next scan: Package / Box / Tracking / LPN";
    if (mode === "pallet" && palletStep === "scan_items") return "Next scan: Item barcode";
    if (mode === "box" && boxStep === "scan_package") return "Next scan: Package / Box / Tracking / LPN";
    if (mode === "box" && boxStep === "scan_items") return "Next scan: Item barcode";
    if (mode === "item") return "Next scan: Item barcode";
    return "Next scan";
  }, [mode, palletStep, boxStep]);

  const workflowSteps = useMemo(() => {
    type StepState = "completed" | "active" | "upcoming";
    type Step = { label: string; state: StepState };

    if (mode === "pallet") {
      if (!currentPallet) return [{ label: "Pallet", state: "active" }] as Step[];
      if (!currentBox) {
        return [
          { label: "Pallet", state: "completed" },
          { label: "Package / Box", state: "active" },
        ] as Step[];
      }
      return [
        { label: "Pallet", state: "completed" },
        { label: "Package / Box", state: "completed" },
        { label: "Items", state: "active" },
      ] as Step[];
    }

    if (mode === "box") {
      if (!currentBox) return [{ label: "Package / Box", state: "active" }] as Step[];
      return [
        { label: "Package / Box", state: "completed" },
        { label: "Items", state: "active" },
      ] as Step[];
    }

    if (mode === "item") {
      return [{ label: "Items", state: "active" }] as Step[];
    }

    return [] as Step[];
  }, [mode, currentPallet, currentBox]);

  const isPalletMode = mode === "pallet";
  const isBoxMode = mode === "box";
  const showBackToPackages = isPalletMode && palletStep === "scan_items" && !!currentBox;
  const showClosePallet = isPalletMode && currentPallet != null && palletStep !== "scan_pallet";
  const showClosePackageBox =
    (isPalletMode && currentBox != null && palletStep === "scan_items") ||
    (isBoxMode && currentBox != null && (boxStep === "set_expected_items" || boxStep === "scan_items"));
  const showStartPackages = isPalletMode && palletStep === "set_expected_packages";
  const showStartItems =
    (isPalletMode && palletStep === "set_package_expected_items" && currentBox != null) ||
    (isBoxMode && boxStep === "set_expected_items" && currentBox != null);

  /** Non-null only when operator entered a valid package/box count for the pallet session. */
  const parsedPalletExpectedPackages = useMemo((): number | null => {
    const t = palletExpectedPackagesInput.trim();
    if (t === "") return null;
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
  }, [palletExpectedPackagesInput]);

  /** Non-null only when operator entered a valid expected item count (non-negative integer). */
  const parsedPackageExpectedItems = useMemo((): number | null => {
    const t = packageExpectedItemsInput.trim();
    if (t === "") return null;
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }, [packageExpectedItemsInput]);

  const onSaveSessionPlaceholder = useCallback(() => {
    setSaveNotice("Progress save will be connected to database next.");
    setTimeout(() => setSaveNotice(null), 2200);
  }, []);

  const onStartPackages = useCallback(() => {
    if (!currentPalletRecordId) {
      pushResult(
        "Error: Pallet session is missing a pallet record — go back and scan the pallet barcode again.",
      );
      return;
    }
    if (palletExpectedPackagesInput.trim() === "" || parsedPalletExpectedPackages == null) {
      setSaveNotice("Enter expected package/box count first.");
      setTimeout(() => setSaveNotice(null), 4200);
      return;
    }
    setPalletStep("scan_packages");
    pushResult(`Pallet session started — operator counted packages: ${parsedPalletExpectedPackages}`);
  }, [
    currentPalletRecordId,
    palletExpectedPackagesInput,
    parsedPalletExpectedPackages,
    pushResult,
  ]);

  const onStartItems = useCallback(async () => {
    if (persistBusy || (mode !== "pallet" && mode !== "box")) return;
    if (!currentPackageRecordId) {
      pushResult("Error: No package linked — scan a package/box before starting items.");
      return;
    }
    if (packageExpectedItemsInput.trim() === "" || parsedPackageExpectedItems == null) {
      setSaveNotice("Enter expected item count first.");
      setTimeout(() => setSaveNotice(null), 4200);
      return;
    }
    const count = parsedPackageExpectedItems;
    setPersistBusy(true);
    try {
      const ur = await updatePackage(
        currentPackageRecordId,
        { expected_item_count: count },
        actorName ?? "operator",
        actorUserId,
      );
      if (!ur.ok) {
        pushResult(`Warning: Expected count not synced — ${ur.error ?? "update failed."}`);
      } else {
        pushResult(`Package expected items set to ${count}`);
      }

      if (mode === "pallet") setPalletStep("scan_items");
      else setBoxStep("scan_items");
      pushResult(`Item scanning started — operator counted items: ${count}`);
    } finally {
      setPersistBusy(false);
    }
  }, [
    persistBusy,
    mode,
    currentPackageRecordId,
    packageExpectedItemsInput,
    parsedPackageExpectedItems,
    actorName,
    actorUserId,
    pushResult,
  ]);

  const placeholderMetrics = [
    { label: "Expected count", value: "120" },
    { label: "Scanned count", value: "84" },
    { label: "Missing count", value: "36" },
    { label: "Unexpected count", value: "7" },
    { label: "Match %", value: "70%" },
    { label: "Claim candidate count", value: "3" },
  ];

  const lastScanResult = scanResults[0] ?? null;
  const lastScanTone: ResultTone | null = lastScanResult
    ? inferResultTone(lastScanResult.text)
    : null;
  const lastScanHeadline = useMemo(() => {
    if (lastScanTone === "success") return "✔ ITEM SCANNED";
    if (lastScanTone === "warning") return "⚠ UNEXPECTED ITEM";
    if (lastScanTone === "error") return "❌ MISSING ITEM";
    return "READY TO SCAN";
  }, [lastScanTone]);

  useEffect(() => {
    if (!lastScanTone) return;
    setScanFeedbackTone(lastScanTone);
    setScanFeedbackActive(true);
    const timer = setTimeout(() => setScanFeedbackActive(false), 300);
    return () => clearTimeout(timer);
  }, [lastScanTone, lastScanResult]);

  const shellBg =
    "min-h-[100dvh] min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-cyan-500/30";
  /** Scroll areas clear the fixed action bar (h-12 + gap + safe area). */
  const scrollPadOverActions =
    "pb-[max(9.5rem,calc(6.5rem+env(safe-area-inset-bottom,0px)))] sm:pb-[max(10rem,calc(6.75rem+env(safe-area-inset-bottom,0px)))]";

  return (
    <div
      className={shellBg}
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))" }}
    >
      <header className="shrink-0 border-b border-zinc-800/90 bg-zinc-900/80 px-3 py-3 min-[400px]:py-2.5 backdrop-blur-md">
        <div className="mx-auto flex max-w-2xl items-center gap-2.5 min-[400px]:items-center">
          <div className="flex h-10 w-10 min-[400px]:h-9 min-[400px]:w-9 items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-500/10">
            <ScanLine className="h-5 w-5 text-cyan-400" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Warehouse</p>
            <h1 className="text-base min-[400px]:text-sm font-bold leading-snug text-white">Operator scanner</h1>
          </div>
        </div>
      </header>

      {mode == null && (
        <main className={`mx-auto w-full max-w-4xl flex-1 px-3 py-4 sm:px-4 sm:py-5 ${scrollPadOverActions}`}>
          <div className="mb-4 text-center sm:mb-5">
            <p className="text-lg font-bold text-white sm:text-xl">Scanner home</p>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400 sm:text-base">
              Pick a task. Writes use your warehouse session and `/returns` server actions when you scan.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <button
              type="button"
              onClick={() => goMode("pallet")}
              className="group flex min-h-[128px] min-w-0 flex-col items-start gap-2 rounded-2xl border-2 border-violet-500/40 bg-violet-950/50 p-4 text-left shadow-lg shadow-black/20 active:scale-[0.99] transition hover:border-violet-400/70 hover:bg-violet-900/50 sm:min-h-[132px] sm:p-5"
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="text-base font-bold text-violet-100 sm:text-lg">Start Pallet Receiving</span>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-400/30 bg-violet-500/20 text-violet-200">
                  <Plus className="h-5 w-5" strokeWidth={2.5} />
                </span>
              </div>
              <p className="text-sm leading-snug text-violet-200/80">
                Start a pallet, then add boxes and scan items. Best for a full LPN run.
              </p>
            </button>
            <button
              type="button"
              onClick={() => goMode("box")}
              className="group flex min-h-[128px] min-w-0 flex-col items-start gap-2 rounded-2xl border-2 border-sky-500/40 bg-sky-950/50 p-4 text-left shadow-lg shadow-black/20 active:scale-[0.99] transition hover:border-sky-400/70 hover:bg-sky-900/50 sm:min-h-[132px] sm:p-5"
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="text-base font-bold text-sky-100 sm:text-lg">Start Package / Box Receiving</span>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-sky-400/30 bg-sky-500/20 text-sky-200">
                  <Box className="h-5 w-5" strokeWidth={2.5} />
                </span>
              </div>
              <p className="text-sm leading-snug text-sky-200/80">
                Start from one box/package, then scan items. No pallet step.
              </p>
            </button>
            <button
              type="button"
              onClick={() => goMode("item")}
              className="group flex min-h-[128px] min-w-0 flex-col items-start gap-2 rounded-2xl border-2 border-emerald-500/40 bg-emerald-950/50 p-4 text-left shadow-lg shadow-black/20 active:scale-[0.99] transition hover:border-emerald-400/70 hover:bg-emerald-900/50 sm:min-h-[132px] sm:p-5"
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="text-base font-bold text-emerald-100 sm:text-lg">Start Loose Item Receiving</span>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/20 text-emerald-200">
                  <Package className="h-5 w-5" strokeWidth={2.5} />
                </span>
              </div>
              <p className="text-sm leading-snug text-emerald-200/80">Items only. Box or pallet is not required in this path.</p>
            </button>
            <button
              type="button"
              onClick={() => goMode("continue")}
              className="group flex min-h-[128px] min-w-0 flex-col items-start gap-2 rounded-2xl border-2 border-zinc-600 bg-zinc-900/80 p-4 text-left shadow-lg shadow-black/20 active:scale-[0.99] transition hover:border-zinc-500 hover:bg-zinc-800/80 sm:min-h-[132px] sm:p-5"
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="text-base font-bold text-zinc-100 sm:text-lg">Continue Existing Work</span>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-500/50 bg-zinc-800 text-zinc-200">
                  <Redo2 className="h-5 w-5" strokeWidth={2.5} />
                </span>
              </div>
              <p className="text-sm leading-snug text-zinc-400">Resume an open session from search or a scan. Lookup comes next.</p>
            </button>
          </div>
        </main>
      )}

      {mode === "continue" && (
        <main
          className={`mx-auto flex w-full max-w-2xl flex-1 flex-col px-3 pt-3 sm:px-4 ${scrollPadOverActions}`}
        >
          <div className="mb-3 rounded-xl border border-cyan-500/25 bg-cyan-950/30 px-3 py-2.5 sm:px-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-300">
              <span>
                <span className="text-zinc-500">Mode</span>{" "}
                <span className="font-semibold text-cyan-200/90">Continue Existing</span>
              </span>
              <span className="text-zinc-600">|</span>
              <span>
                <span className="text-zinc-500">Step</span> <span className="font-mono text-zinc-200">Lookup</span>
              </span>
            </div>
          </div>

          <div className="flex flex-1 flex-col items-center">
            <div className="w-full max-w-md rounded-2xl border-2 border-dashed border-cyan-500/35 bg-zinc-900/60 p-1 shadow-inner">
              <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl bg-black/20 px-3 py-8 text-center min-[400px]:px-4 sm:min-h-[240px]">
                <div className="mb-0 flex h-16 w-16 min-[400px]:h-14 min-[400px]:w-14 items-center justify-center rounded-2xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400">
                  <ScanLine className="h-9 w-9 min-[400px]:h-8 min-[400px]:w-8" />
                </div>
                <p className="px-1 text-sm min-[400px]:text-base font-medium leading-snug text-zinc-100 sm:leading-relaxed">
                  Scan pallet, package, item, tracking, or search open work
                </p>
                <p className="mt-1 max-w-sm text-xs leading-normal text-zinc-400 min-[400px]:text-sm">
                  Scans create or link pallets, packages, and items against your tenant data where possible.
                </p>
                <p className="text-xs text-zinc-500 min-[400px]:text-sm">
                  Use Back below. Input unlocks when lookup is live.
                </p>
              </div>
            </div>
          </div>

          <div
            className="fixed bottom-0 left-0 right-0 z-30 border-t border-zinc-800/90 bg-zinc-950/95 px-2 py-2.5 shadow-[0_-4px_24px_rgba(0,0,0,0.4)] backdrop-blur-md sm:px-4"
            style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))" }}
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-2 min-[400px]:flex-row min-[400px]:flex-wrap min-[400px]:justify-center">
              <button
                type="button"
                onClick={goHome}
                className="inline-flex h-12 min-h-[48px] w-full min-w-0 min-[400px]:min-w-[140px] min-[400px]:flex-1 min-[400px]:w-auto items-center justify-center gap-2 rounded-xl border-2 border-zinc-600 bg-zinc-800/90 px-3 text-sm font-semibold text-zinc-100 active:bg-zinc-700/90 sm:flex-initial"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" /> Back to home
              </button>
            </div>
          </div>
        </main>
      )}

      {isScannerView && mode !== "continue" && (
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
          <div className="shrink-0 border-b border-zinc-800/80 bg-zinc-900/50 px-3 py-3 sm:px-4 sm:py-2.5">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="min-w-0 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Status</p>
                <p className="text-sm min-[400px]:text-base leading-snug font-semibold text-white sm:truncate">
                  {modeLabel}
                  <span className="mx-1.5 text-zinc-600">·</span>
                  <span className="text-zinc-300">{stepLabel}</span>
                </p>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <div className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-black/20 px-2.5 py-1.5 text-xs">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/30" aria-hidden />
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-zinc-200">
                    Active
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-2 rounded-xl border border-zinc-700/80 bg-zinc-950/60 px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Active workflow</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                {workflowSteps.map((step, idx) => (
                  <div key={`${step.label}-${idx}`} className="inline-flex items-center gap-1.5">
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 ${
                        step.state === "active"
                          ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/50"
                          : step.state === "completed"
                            ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/35"
                            : "bg-zinc-800/80 text-zinc-500 ring-1 ring-zinc-700/70"
                      }`}
                    >
                      {step.state === "completed" ? `${step.label} ✓` : step.label}
                      {step.state === "active" ? " (active)" : ""}
                    </span>
                    {idx < workflowSteps.length - 1 && <span className="text-zinc-600">&gt;</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div
            className={`flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-3 pt-3 sm:px-4 sm:pt-4 ${scrollPadOverActions}`}
          >
            <div className="mb-4 px-1">
              <p className="flex items-baseline justify-between gap-3 border-b border-zinc-800/70 py-1.5 text-sm">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Pallet</span>
                <span className="min-w-0 flex-1 text-right">
                  <span className="inline-flex max-w-full items-center truncate rounded-md border border-violet-500/45 bg-violet-950/50 px-2.5 py-1 font-mono text-sm font-extrabold text-violet-200 [overflow-wrap:anywhere]">
                    {currentPallet ?? <span className="text-zinc-500">No pallet parent</span>}
                  </span>
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3 border-b border-zinc-800/70 py-1.5 text-sm">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Package / Box</span>
                <span className="min-w-0 flex-1 text-right">
                  <span className="inline-flex max-w-full items-center truncate rounded-md border border-sky-500/45 bg-sky-950/50 px-2.5 py-1 font-mono text-sm font-extrabold text-sky-200 [overflow-wrap:anywhere]">
                    {currentBox ?? <span className="text-zinc-500">No package parent</span>}
                  </span>
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Item scope</span>
                <span className="text-right text-xs font-semibold text-emerald-300">
                  {mode === "item"
                    ? "Loose / Orphan item (No package / no pallet)"
                    : "Child of active package / box"}
                </span>
              </p>
            </div>

            {mode === "pallet" && palletStep === "set_expected_packages" && (
              <section className="mb-4 rounded-xl border border-violet-500/35 bg-violet-950/25 p-3">
                <p className="text-xs font-semibold text-violet-200">Pallet details (compact)</p>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  <div>
                    <label className="text-[11px] font-semibold text-zinc-300">Carrier</label>
                    <select
                      value={palletCarrier}
                      onChange={(e) => setPalletCarrier(e.target.value)}
                      className="mt-1 h-10 w-full rounded-lg border border-zinc-600 bg-zinc-950 px-2 text-sm text-zinc-100"
                    >
                      <option>UPS</option>
                      <option>FedEx</option>
                      <option>USPS</option>
                      <option>Amazon</option>
                      <option>Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-zinc-300">
                      Store <span className="text-amber-400/90">(required)</span>
                    </label>
                    <p className="mt-0.5 text-[10px] text-zinc-500">
                      From System Settings — only stores for your organization.
                    </p>
                    <select
                      value={palletStoreId}
                      onChange={(e) => setPalletStoreId(e.target.value)}
                      disabled={storesLoading}
                      className={`mt-1 h-10 w-full rounded-lg border bg-zinc-950 px-2 text-sm text-zinc-100 disabled:opacity-60 ${
                        !palletStoreId ? "border-amber-500/50" : "border-zinc-600"
                      }`}
                    >
                      <option value="">
                        {storesLoading ? "Loading stores..." : "Select store"}
                      </option>
                      {storesForOrganization.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.platform ? ` (${s.platform})` : ""}
                        </option>
                      ))}
                    </select>
                    {storesLoadError && (
                      <p className="mt-1 text-[11px] text-red-400">{storesLoadError}</p>
                    )}
                    {!storesLoading && !storesLoadError && storesForOrganization.length === 0 && (
                      <p className="mt-1 text-[11px] text-zinc-500">
                        No active stores found. Add stores in System Settings.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-zinc-300">Amazon Order ID (optional)</label>
                    <input
                      type="text"
                      value={palletAmazonOrderId}
                      onChange={(e) => setPalletAmazonOrderId(e.target.value)}
                      className="mt-1 h-10 w-full rounded-lg border border-zinc-600 bg-zinc-950 px-2 text-sm text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-zinc-300">Notes (optional)</label>
                    <textarea
                      value={palletNotes}
                      onChange={(e) => setPalletNotes(e.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-zinc-600 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
                    <button
                      type="button"
                      className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-600 bg-zinc-800/75 text-xs font-semibold text-zinc-200"
                    >
                      Pallet photo
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-600 bg-zinc-800/75 text-xs font-semibold text-zinc-200"
                    >
                      Bill of Lading photo
                    </button>
                  </div>
                </div>
                <p className="text-xs font-semibold text-violet-200">Operator counted packages / boxes</p>
                <input
                  type="number"
                  min={1}
                  value={palletExpectedPackagesInput}
                  onChange={(e) => setPalletExpectedPackagesInput(e.target.value)}
                  placeholder="Enter count"
                  className="mt-2 h-12 w-full rounded-lg border-2 border-violet-400/40 bg-zinc-950 px-3 text-center text-2xl font-bold text-white focus:border-violet-300 focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-zinc-400">
                  Packages created under this pallet will inherit carrier/store/order later.
                </p>
                <p className="mt-1 text-[11px] text-zinc-400">
                  This is the number of packages/boxes received with this pallet.
                </p>
                {parsedPalletExpectedPackages == null && (
                  <p className="mt-2 text-xs font-medium text-amber-300/95" role="status">
                    {palletExpectedPackagesInput.trim() === ""
                      ? "Enter expected package/box count first."
                      : "Enter a valid package/box count (at least 1)."}
                  </p>
                )}
              </section>
            )}

            {mode === "pallet" && palletStep === "scan_packages" && (
              <section className="mb-4 rounded-xl border border-sky-500/35 bg-sky-950/25 p-3">
                <p className="text-xs font-semibold text-sky-200">
                  Package progress: {palletScannedPackages} /{" "}
                  {parsedPalletExpectedPackages ?? "—"}
                </p>
                <p className="mt-1 text-xs text-zinc-400">Scan packages under pallet parent {currentPallet ?? "—"}.</p>
              </section>
            )}

            {((mode === "pallet" && palletStep === "set_package_expected_items") ||
              (mode === "box" && boxStep === "set_expected_items")) && (
              <section className="mb-4 rounded-xl border border-emerald-500/35 bg-emerald-950/25 p-3">
                <p className="text-xs font-semibold text-emerald-200">
                  Operator counted quantity: items in this package / box
                </p>
                <input
                  type="number"
                  min={0}
                  value={packageExpectedItemsInput}
                  onChange={(e) => setPackageExpectedItemsInput(e.target.value)}
                  placeholder="Enter count"
                  className="mt-2 h-12 w-full rounded-lg border-2 border-emerald-400/40 bg-zinc-950 px-3 text-center text-2xl font-bold text-white focus:border-emerald-300 focus:outline-none"
                />
                {mode === "box" && (
                  <button
                    type="button"
                    className="mt-2 inline-flex h-9 w-full items-center justify-center rounded-lg border border-zinc-600 bg-zinc-800/75 text-xs font-semibold text-zinc-200"
                  >
                    Link to pallet later (placeholder)
                  </button>
                )}
                <p className="mt-1 text-[11px] text-zinc-400">
                  Operator count is synced to this package when you tap Start items.
                </p>
                {parsedPackageExpectedItems == null && (
                  <p className="mt-2 text-xs font-medium text-amber-300/95" role="status">
                    {packageExpectedItemsInput.trim() === ""
                      ? "Enter expected item count first."
                      : "Enter a valid non-negative whole number."}
                  </p>
                )}
              </section>
            )}

            {mode === "item" && (
              <section className="mb-4 rounded-xl border border-zinc-700/80 bg-zinc-900/40 p-3">
                <p className="text-xs font-semibold text-zinc-200">Loose / Orphan item</p>
                <p className="mt-1 text-xs text-zinc-400">Manager can link this item later.</p>
              </section>
            )}

            {showScanForm ? (
              <form ref={scanFormRef} onSubmit={onScanSubmit} className="mb-4">
                <label
                  htmlFor="operator-scan"
                  className="mb-2 block text-center text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-300/90"
                >
                  {nextScanLabel}
                </label>
                <input
                  id="operator-scan"
                  ref={inputRef}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="Scan or type"
                  disabled={persistBusy}
                  className={`block w-full rounded-2xl border-4 bg-zinc-950 px-4 py-5 text-center font-mono text-3xl font-bold tracking-wider text-white shadow-[inset_0_4px_16px_rgba(0,0,0,0.5),0_0_0_4px_rgba(34,211,238,0.08)] placeholder:text-zinc-700 focus:outline-none focus:ring-4 disabled:cursor-wait disabled:opacity-60 sm:py-6 sm:text-4xl ${
                    scanFeedbackActive && scanFeedbackTone === "success"
                      ? "border-emerald-400 focus:border-emerald-300 focus:ring-emerald-400/45"
                      : scanFeedbackActive && scanFeedbackTone === "warning"
                        ? "border-amber-400 focus:border-amber-300 focus:ring-amber-400/45"
                        : scanFeedbackActive && scanFeedbackTone === "error"
                          ? "border-red-400 focus:border-red-300 focus:ring-red-400/45"
                          : "border-cyan-500/60 focus:border-cyan-400 focus:ring-cyan-400/40"
                  }`}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      scanFormRef.current?.requestSubmit();
                    }
                  }}
                />
                <button type="submit" className="hidden" aria-hidden>
                  Submit scan
                </button>
                <p className="mt-1.5 text-center text-[11px] text-zinc-500">
                  {mode === "pallet" && palletStep === "scan_pallet"
                    ? "Scan pallet tracking / pallet label first."
                    : "Main flow: scan package/box/tracking/LPN, then continue scanning items."}
                </p>
              </form>
            ) : (
              <p className="mb-4 text-center text-sm text-amber-200/80">Scanning unavailable.</p>
            )}

            <section className="mb-4" aria-label="Last scan result">
              <h2 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                Last scan result
              </h2>
              {lastScanResult == null ? (
                <div>
                  <div className="flex items-center justify-center rounded-xl border-2 border-dashed border-zinc-700 bg-zinc-900/30 px-3 py-5 text-sm text-zinc-500">
                    No scans yet — scan to begin.
                  </div>
                  <p className="mt-2 rounded-lg border border-zinc-700/80 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
                    Fix item details appears here when a scan is unexpected or has a problem.
                  </p>
                </div>
              ) : (
                <div>
                  <div
                    className={`flex items-center gap-3 rounded-xl border-2 px-4 py-4 transition-all duration-300 ${
                      scanFeedbackActive ? "scale-[1.01]" : "scale-100"
                    } ${
                      lastScanTone === "success"
                        ? "border-emerald-500/70 bg-emerald-900/55 text-emerald-50 shadow-[0_0_0_2px_rgba(16,185,129,0.2)]"
                        : lastScanTone === "warning"
                          ? "border-amber-500/70 bg-amber-900/55 text-amber-50 shadow-[0_0_0_2px_rgba(245,158,11,0.2)]"
                          : lastScanTone === "error"
                            ? "border-red-500/70 bg-red-900/55 text-red-50 shadow-[0_0_0_2px_rgba(239,68,68,0.2)]"
                            : "border-zinc-700 bg-zinc-900/40 text-zinc-100"
                    }`}
                  >
                    {lastScanTone === "success" ? (
                      <CheckCircle2 className="h-9 w-9 shrink-0 text-emerald-300" aria-hidden />
                    ) : lastScanTone === "warning" ? (
                      <AlertTriangle className="h-9 w-9 shrink-0 text-amber-300" aria-hidden />
                    ) : lastScanTone === "error" ? (
                      <XCircle className="h-9 w-9 shrink-0 text-red-300" aria-hidden />
                    ) : (
                      <ScanLine className="h-9 w-9 shrink-0 text-zinc-400" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/90">
                        {lastScanHeadline}
                      </p>
                      <p className="mt-1 break-words text-lg font-extrabold leading-tight [overflow-wrap:anywhere] sm:text-2xl">
                        {lastScanResult.text.toUpperCase()}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
                        {lastScanResult.at}
                      </p>
                    </div>
                  </div>
                  {(lastScanTone === "warning" || lastScanTone === "error") && (
                    <button
                      type="button"
                      className={`mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border-2 px-3 text-sm font-semibold ${
                        lastScanTone === "error"
                          ? "border-red-500/70 bg-red-950/40 text-red-100"
                          : "border-amber-500/70 bg-amber-950/45 text-amber-100"
                      }`}
                    >
                      Fix item details
                    </button>
                  )}
                </div>
              )}
            </section>

            {packageLookup && (
              <section className="mb-4" aria-label="Package lookup">
                {packageLookup.matchedExpected ? (
                  <div className="rounded-xl border border-emerald-500/45 bg-emerald-950/30 p-3">
                    <p className="text-sm font-semibold text-emerald-100">Matched expected package</p>
                    <p className="mt-1 break-all font-mono text-xs text-emerald-200/90">{packageLookup.scannedValue}</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-500/45 bg-amber-950/30 p-3">
                    <p className="text-sm font-semibold text-amber-100">No expected-package row for this scan</p>
                  </div>
                )}
                {packageLookup.matchedExistingPackage ? (
                  <p className="mt-2 text-xs text-zinc-400">Existing package record — linked (no duplicate created).</p>
                ) : (
                  <p className="mt-2 text-xs text-zinc-400">New package row created or linked after duplicate handling.</p>
                )}
              </section>
            )}

            <section className="mb-4" aria-label="Progress overview">
              <h2 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                Progress
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/15 px-2.5 py-2.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-300/75">Scanned</p>
                  <p className="mt-1 text-xl font-bold text-emerald-100">84</p>
                </div>
                <div className="rounded-xl border border-red-500/25 bg-red-950/15 px-2.5 py-2.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-red-300/75">Missing</p>
                  <p className="mt-1 text-xl font-bold text-red-100">36</p>
                </div>
              </div>
            </section>

            <details className="group mb-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3 text-sm font-semibold text-zinc-200 [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-amber-300/80" />
                  Advanced / Manager tools
                </span>
                <ChevronDown className="h-4 w-4 text-zinc-400 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-4 border-t border-zinc-800 px-3 py-3">
                <section aria-label="All progress metrics">
                  <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">All metrics</h3>
                  <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-3">
                    {placeholderMetrics.map((metric) => (
                      <div
                        key={metric.label}
                        className="rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-3 py-2"
                      >
                        <p className="text-[11px] text-zinc-500">{metric.label}</p>
                        <p className="mt-1 text-base font-bold text-zinc-100">{metric.value}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section aria-label="Match status states">
                  <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Match status</h3>
                  <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-3">
                    <div className="rounded-lg border border-emerald-500/45 bg-emerald-950/35 px-3 py-2.5">
                      <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-200">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Matched
                      </p>
                      <p className="mt-1 text-xs text-emerald-100/85">Green: expected and matched.</p>
                    </div>
                    <div className="rounded-lg border border-amber-500/45 bg-amber-950/35 px-3 py-2.5">
                      <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                        <HelpCircle className="h-3.5 w-3.5" /> Unexpected / Unknown
                      </p>
                      <p className="mt-1 text-xs text-amber-100/85">Yellow: needs operator verification.</p>
                    </div>
                    <div className="rounded-lg border border-red-500/45 bg-red-950/35 px-3 py-2.5">
                      <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-200">
                        <FileWarning className="h-3.5 w-3.5" /> Missing / Problem
                      </p>
                      <p className="mt-1 text-xs text-red-100/85">Red: missing/problem/claim candidate.</p>
                    </div>
                  </div>
                </section>

                <section aria-label="Drill down cards">
                  <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                    Drill-down card view
                  </h3>
                  <div className="space-y-2">
                    <div className="rounded-lg border border-violet-500/35 bg-violet-950/25 p-2.5">
                      <p className="text-xs font-semibold text-violet-200">Pallet card</p>
                      <p className="mt-1 text-xs text-violet-100/85">
                        {currentPallet ? `Active: ${currentPallet}` : "No active pallet selected yet."}
                      </p>
                    </div>
                    <div className="rounded-lg border border-sky-500/35 bg-sky-950/25 p-2.5">
                      <p className="text-xs font-semibold text-sky-200">Box cards</p>
                      <p className="mt-1 text-xs text-sky-100/85">
                        {currentBox ? `Active: ${currentBox}` : "Scan/select a box to continue receiving items."}
                      </p>
                    </div>
                    <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/25 p-2.5">
                      <p className="text-xs font-semibold text-emerald-200">Item rows/cards</p>
                      <p className="mt-1 text-xs text-emerald-100/85">
                        Latest scans appear in activity and can be rendered as item cards.
                      </p>
                    </div>
                  </div>
                </section>

                <section aria-label="Evidence placeholders">
                  <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                    Evidence / photos
                  </h3>
                  <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
                    {[
                      "Packing slip photo",
                      "Label photo",
                      "Outer box photo",
                      "Inside content photo",
                    ].map((label) => (
                      <button
                        key={label}
                        type="button"
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-zinc-600 bg-zinc-800/75 text-xs font-semibold text-zinc-200"
                      >
                        <Camera className="h-3.5 w-3.5" />
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border border-zinc-600 bg-zinc-800/75 px-3 text-xs font-semibold text-zinc-200"
                  >
                    Open full package form
                  </button>
                  <p className="mt-2 text-xs text-zinc-500">Placeholder only. Camera capture will be connected later.</p>
                </section>

                <section aria-label="Manual correction and manager review">
                  <h3 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-amber-300/90">
                    Manual correction / manager review
                  </h3>
                  <p className="mb-2 text-xs text-amber-100/85">
                    Use this path when scans are uncertain or status is unexpected.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-600 bg-zinc-800/75 px-3 text-xs font-semibold text-zinc-200"
                    >
                      Open full pallet form
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-10 items-center gap-2 rounded-lg border-2 border-cyan-500/55 bg-cyan-950/35 px-3 text-xs font-semibold text-cyan-100"
                    >
                      Open full single item form
                      <span className="text-[10px] font-medium text-cyan-300/85">(Manual/admin fallback)</span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-amber-500/45 bg-amber-950/50 px-3 text-xs font-semibold text-amber-100"
                    >
                      <ClipboardList className="h-3.5 w-3.5" />
                      Open Manual Correction
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-red-500/45 bg-red-950/40 px-3 text-xs font-semibold text-red-100"
                    >
                      <ShieldAlert className="h-3.5 w-3.5" />
                      Request Manager Review
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-zinc-400">
                    Use this only for manual/admin exception handling. Scanner mode stays fast.
                  </p>
                </section>

                <section aria-label="Activity feed">
                  <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Activity</h3>
                  <ul
                    className="max-h-48 list-none space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-black/20 p-1.5"
                    data-feed="activity"
                  >
                    {scanResults.length === 0 ? (
                      <li className="px-1 py-6 text-center text-sm leading-relaxed text-zinc-500">
                        No events yet. Scans will appear here.
                      </li>
                    ) : (
                      scanResults.map((line) => {
                        const tone = inferResultTone(line.text);
                        return (
                          <li
                            key={line.id}
                            className={`flex gap-2 rounded-lg py-2 pl-2.5 pr-2 text-sm leading-snug ${toneRowClass[tone]}`}
                          >
                            <time className="w-[3.75rem] shrink-0 font-mono text-[10px] text-zinc-500 min-[400px]:w-[4.5rem]">
                              {line.at}
                            </time>
                            <span className="min-w-0 flex-1 break-words text-zinc-200">{line.text}</span>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </section>
              </div>
            </details>
          </div>

          <div
            className="fixed bottom-0 left-0 right-0 z-30 border-t border-zinc-800/90 bg-zinc-950/95 py-2 pl-1.5 pr-1.5 shadow-[0_-4px_24px_rgba(0,0,0,0.5)] backdrop-blur-md min-[400px]:px-2 sm:py-2.5 sm:pl-4 sm:pr-4"
            style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))" }}
          >
            <div className="mx-auto mb-2 max-w-2xl text-center text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Hierarchy: Pallet (parent) &gt; Package / Box (child) &gt; Item
            </div>
            {saveNotice && (
              <div className="mx-auto mb-2 max-w-2xl rounded-lg border border-cyan-500/40 bg-cyan-950/40 px-3 py-2 text-center text-xs font-semibold text-cyan-100">
                {saveNotice}
              </div>
            )}
            <div className="mx-auto grid max-w-2xl grid-cols-2 gap-1.5 min-[480px]:flex min-[480px]:flex-nowrap min-[480px]:justify-stretch min-[480px]:gap-2">
              <button
                type="button"
                onClick={showBackToPackages ? closeBox : goHome}
                className="inline-flex h-12 min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-zinc-600 bg-zinc-800/90 text-[10px] font-bold uppercase tracking-wide text-zinc-100 transition active:scale-[0.99] min-[400px]:text-xs sm:text-[11px] enabled:hover:bg-zinc-700"
              >
                <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden min-[400px]:inline">
                  {showBackToPackages ? "Back to Packages" : "Back to home"}
                </span>
                <span className="inline min-[400px]:hidden">Back</span>
              </button>
              <button
                type="button"
                onClick={onSaveSessionPlaceholder}
                className="inline-flex h-12 min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-cyan-500/45 bg-cyan-950/60 text-[10px] font-bold uppercase tracking-wide text-cyan-100 transition active:scale-[0.99] min-[400px]:text-xs sm:text-[11px] hover:bg-cyan-900/50"
              >
                <Redo2 className="h-3.5 w-3.5 shrink-0" />
                <span>Save session</span>
              </button>
              {showStartPackages && (
                <button
                  type="button"
                  onClick={onStartPackages}
                  disabled={
                    persistBusy ||
                    !currentPalletRecordId ||
                    parsedPalletExpectedPackages == null
                  }
                  className="inline-flex h-12 min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-violet-500/45 bg-violet-950/60 text-[10px] font-bold uppercase tracking-wide text-violet-100 transition active:scale-[0.99] min-[400px]:text-xs sm:text-[11px] hover:bg-violet-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Boxes className="h-3.5 w-3.5 shrink-0" />
                  <span>Start packages</span>
                </button>
              )}
              {showStartItems && (
                <button
                  type="button"
                  onClick={() => void onStartItems()}
                  disabled={
                    persistBusy ||
                    !currentPackageRecordId ||
                    parsedPackageExpectedItems == null
                  }
                  className="inline-flex h-12 min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-500/45 bg-emerald-950/60 text-[10px] font-bold uppercase tracking-wide text-emerald-100 transition active:scale-[0.99] min-[400px]:text-xs sm:text-[11px] hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ScanLine className="h-3.5 w-3.5 shrink-0" />
                  <span>Start items</span>
                </button>
              )}
              {showClosePackageBox && (
                <button
                  type="button"
                  onClick={closeBox}
                  className="inline-flex h-12 min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-sky-500/45 bg-sky-950/70 text-[10px] font-bold uppercase tracking-wide text-sky-100 transition active:scale-[0.99] min-[400px]:text-xs sm:text-[11px] enabled:hover:bg-sky-900/60"
                >
                  <Package className="h-3.5 w-3.5 shrink-0" /> <span>Finish package</span>
                </button>
              )}
              {showClosePallet && (
                <button
                  type="button"
                  onClick={closePallet}
                  className="inline-flex h-12 min-h-[48px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-violet-500/45 bg-violet-950/60 text-[9px] font-bold uppercase tracking-wide text-violet-100 transition active:scale-[0.99] min-[400px]:text-xs sm:text-[11px] enabled:hover:bg-violet-900/50"
                >
                  <Boxes className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-center leading-tight">Finish pallet</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
