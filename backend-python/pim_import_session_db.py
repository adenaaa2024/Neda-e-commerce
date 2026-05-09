"""
Persist PIM async import session rows (public.pim_import_sessions) alongside raw_report_uploads.
Service-role Supabase client only (ETL + server actions).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def pim_import_session_cancelled(db: Any, organization_id: str, upload_id: str, meta: dict[str, Any]) -> bool:
    """True if user cancelled via metadata flags or session.cancel_requested_at."""
    if bool(meta.get("pim_import_cancelled")):
        return True
    if str(meta.get("preview_status") or "").strip().lower() == "cancelled":
        return True
    job = meta.get("pim_import_job") if isinstance(meta.get("pim_import_job"), dict) else {}
    if str(job.get("lifecycle") or "").strip().lower() == "cancelled":
        return True
    try:
        r = (
            db.table("pim_import_sessions")
            .select("cancel_requested_at,status")
            .eq("upload_id", upload_id)
            .eq("organization_id", organization_id)
            .limit(1)
            .execute()
        )
        row = (r.data or [None])[0]
        if not row:
            return False
        if row.get("cancel_requested_at"):
            return True
        if str(row.get("status") or "").strip().lower() == "cancelled":
            return True
    except Exception:
        log.debug("pim_import_sessions cancel check skipped", exc_info=True)
    return False


def pim_import_session_ensure(
    db: Any,
    *,
    organization_id: str,
    store_id: str,
    upload_id: str,
    source_filename: str,
    uploaded_by: str | None,
    import_type: str = "pim_product_master",
) -> str | None:
    """Insert session row if missing; return session id."""
    try:
        ex = (
            db.table("pim_import_sessions")
            .select("id")
            .eq("upload_id", upload_id)
            .eq("organization_id", organization_id)
            .limit(1)
            .execute()
        )
        if ex.data:
            return str(ex.data[0]["id"])
        ins = (
            db.table("pim_import_sessions")
            .insert(
                {
                    "organization_id": organization_id,
                    "store_id": store_id,
                    "upload_id": upload_id,
                    "import_type": import_type,
                    "source_filename": source_filename or "upload",
                    "uploaded_by": uploaded_by,
                    "status": "uploaded",
                    "progress_percent": 0,
                    "current_step": "uploaded",
                    "metadata": {},
                }
            )
            .execute()
        )
        if ins.data:
            return str(ins.data[0]["id"])
    except Exception:
        log.exception("pim_import_session_ensure failed upload_id=%s", upload_id)
    return None


def _map_job_to_session_status(meta: dict[str, Any], job: dict[str, Any]) -> tuple[str, str]:
    """Derive (session_status, current_step) from upload metadata + pim_import_job."""
    life = str(job.get("lifecycle") or "").strip().lower()
    pstat = str(meta.get("preview_status") or "").strip().lower()
    if meta.get("pim_import_cancelled") or pstat == "cancelled" or life == "cancelled":
        return "cancelled", "cancelled"
    if life == "completed":
        return "completed", str(job.get("stage_label") or "completed")
    if life == "failed" or pstat == "failed" or pstat == "import_partial_failed":
        return "failed", str(job.get("stage_label") or "failed")
    if life in ("importing", "import_queued"):
        return "importing", str(job.get("stage_label") or "importing")
    if pstat == "preview_ready" or life == "waiting_for_confirmation":
        return "preview_ready", str(job.get("stage_label") or "preview_ready")
    if life == "previewing" or pstat == "previewing":
        return "preview_running", str(job.get("stage_label") or "scanning_rows")
    return "uploaded", str(job.get("stage_label") or "uploaded")


def _quality_to_counters(quality: dict[str, Any]) -> dict[str, Any]:
    rows_total = int(quality.get("rows_total") or 0)
    dirty = int(quality.get("dirty_rows") or quality.get("skipped_dirty_row") or 0)
    skipped = int(quality.get("rows_skipped") or 0) or (
        int(quality.get("skipped_no_identity") or 0) + int(quality.get("skipped_ambiguous") or 0)
    )
    ambiguous = int(quality.get("ambiguous_rows") or quality.get("skipped_ambiguous") or 0)
    conflicts = int(quality.get("conflict_rows_blocked") or 0)
    accepted = int(quality.get("rows_accepted_estimate") or max(rows_total - dirty, 0))
    pub = {}
    for k in (
        "rows_scanned",
        "rows_accepted",
        "rows_rejected",
        "dirty_rate",
        "products_would_create",
        "products_would_update",
        "vendors_would_create",
        "vendors_reused",
        "categories_would_create",
        "categories_reused",
        "identifier_rows_would_insert",
        "identifier_rows_would_update",
        "prices_would_insert",
        "apply_blocked_by_dirty_rate",
        "apply_blocked_by_conflicts",
        "category_import_debug",
    ):
        if k in quality:
            pub[k] = quality.get(k)
    return {
        "total_rows": rows_total,
        "processed_rows": rows_total,
        "accepted_rows": accepted,
        "dirty_rows": dirty,
        "skipped_rows": skipped,
        "ambiguous_rows": ambiguous,
        "conflict_rows": conflicts,
        "preview_metrics": pub,
    }


def pim_import_session_sync(
    db: Any,
    *,
    organization_id: str,
    store_id: str,
    upload_id: str,
    file_name: str,
    uploaded_by: str | None,
    meta: dict[str, Any],
    job: dict[str, Any],
    quality: dict[str, Any] | None = None,
    apply_metrics: dict[str, Any] | None = None,
    frozen_plan: dict[str, Any] | None = None,
) -> None:
    """Upsert counters + status from current metadata job (and optional finalized quality)."""
    sid = pim_import_session_ensure(
        db,
        organization_id=organization_id,
        store_id=store_id,
        upload_id=upload_id,
        source_filename=file_name,
        uploaded_by=uploaded_by,
    )
    if not sid:
        return
    st, step = _map_job_to_session_status(meta, job)
    pct = int(job.get("progress_pct") or 0)
    patch: dict[str, Any] = {
        "updated_at": _iso_now(),
        "status": st,
        "progress_percent": min(100, max(0, pct)),
        "current_step": step[:500] if step else "",
        "last_error": (str(job.get("last_error"))[:2000] if job.get("last_error") else None),
    }
    if frozen_plan is not None:
        patch["frozen_plan"] = frozen_plan
    scan = job.get("scan_cursor") if isinstance(job.get("scan_cursor"), dict) else {}
    apply_cur = job.get("apply_cursor") if isinstance(job.get("apply_cursor"), dict) else {}
    meta_blob = {
        "scan_cursor": scan,
        "apply_cursor": apply_cur,
        "effective_row_chunk": job.get("effective_row_chunk"),
        "apply_effective_row_chunk": job.get("apply_effective_row_chunk"),
        "import_mode": (frozen_plan or {}).get("import_mode") if isinstance(frozen_plan, dict) else None,
        "classifier_signals": (frozen_plan or {}).get("classifier_signals") if isinstance(frozen_plan, dict) else None,
        "preview_progress": job.get("preview_progress"),
    }
    patch["metadata"] = {k: v for k, v in meta_blob.items() if v is not None}

    if quality and isinstance(quality, dict):
        ctr = _quality_to_counters(quality)
        patch["total_rows"] = ctr["total_rows"]
        patch["processed_rows"] = ctr["processed_rows"]
        patch["accepted_rows"] = ctr["accepted_rows"]
        patch["dirty_rows"] = ctr["dirty_rows"]
        patch["skipped_rows"] = ctr["skipped_rows"]
        patch["ambiguous_rows"] = ctr["ambiguous_rows"]
        patch["conflict_rows"] = ctr["conflict_rows"]
        patch["preview_metrics"] = ctr["preview_metrics"]
    if apply_metrics is not None and isinstance(apply_metrics, dict):
        patch["apply_metrics"] = apply_metrics

    if st == "completed":
        patch["completed_at"] = _iso_now()
    elif st == "cancelled":
        patch["cancelled_at"] = _iso_now()

    try:
        db.table("pim_import_sessions").update(patch).eq("id", sid).eq("organization_id", organization_id).execute()
    except Exception:
        log.exception("pim_import_session_sync failed session_id=%s", sid)


def pim_import_session_merge_cancel_from_request(
    db: Any, organization_id: str, upload_id: str, meta: dict[str, Any]
) -> dict[str, Any] | None:
    """If session has cancel_requested_at, return metadata dict with cancel flags merged (caller persists)."""
    try:
        r = (
            db.table("pim_import_sessions")
            .select("cancel_requested_at")
            .eq("upload_id", upload_id)
            .eq("organization_id", organization_id)
            .limit(1)
            .execute()
        )
        row = (r.data or [None])[0]
        if not row or not row.get("cancel_requested_at"):
            return None
    except Exception:
        return None
    meta2 = dict(meta)
    meta2["pim_import_cancelled"] = True
    meta2["preview_status"] = "cancelled"
    meta2["import_job_status"] = "cancelled"
    job = meta2.get("pim_import_job") if isinstance(meta2.get("pim_import_job"), dict) else {}
    job2 = {**job, "lifecycle": "cancelled", "stage_label": "cancelled", "last_error": "cancelled_by_user", "preview_phase": None}
    meta2["pim_import_job"] = job2
    return meta2


def pim_import_session_request_cancel(db: Any, organization_id: str, session_id: str) -> bool:
    """Set cancel_requested_at; ETL mirrors to metadata on next read."""
    try:
        db.table("pim_import_sessions").update({"cancel_requested_at": _iso_now(), "updated_at": _iso_now()}).eq(
            "id", session_id
        ).eq("organization_id", organization_id).execute()
        return True
    except Exception:
        log.exception("pim_import_session_request_cancel failed session_id=%s", session_id)
        return False


def pim_import_session_clear_cancel_requested(db: Any, organization_id: str, upload_id: str) -> None:
    try:
        db.table("pim_import_sessions").update({"cancel_requested_at": None, "updated_at": _iso_now()}).eq(
            "upload_id", upload_id
        ).eq("organization_id", organization_id).execute()
    except Exception:
        pass
