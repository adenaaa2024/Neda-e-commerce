# claim_repository.py
"""
Supabase / database access layer for claim submissions.

All reads and writes to ``claim_submissions`` (and related Supabase Storage
calls) are centralised here so that claim_agent.py and main.py can delegate
DB concerns to a single place.

Public API
----------
repo = ClaimRepository()

repo.get_submissions(org_id=..., submission_ids=..., limit=1) -> list[dict]
repo.get_submission(submission_id, organization_id)           -> dict | None
repo.get_return_for_submission(submission_id, organization_id) -> dict | None
repo.get_return_by_id(return_id, organization_id)           -> dict | None
repo.update_status(submission_id, status)                    -> None
repo.update_result(submission_id, amazon_case_id, status)    -> None
repo.resolve_evidence_pdf_path(report_url)                   -> str | None
ClaimRepository.resolve_amazon_order_id_from_row(row)        -> str | None
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from supabase import create_client, Client, SupabaseException

_env_dir = Path(__file__).resolve().parent
_env_file = _env_dir / ".env"
load_dotenv(dotenv_path=_env_file)

# ---------------------------------------------------------------------------
# Module-level logging
# ---------------------------------------------------------------------------

_LOG_PREFIX = "[claim-repository]"


def _log(msg: str) -> None:
    print(f"{_LOG_PREFIX} {msg}", flush=True)


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------

class ClaimRepository:
    """
    Thin data-access layer over the ``claim_submissions`` Supabase table.

    One instance per request / tenant is fine; the Supabase ``Client`` is
    lightweight and thread-safe for concurrent read operations.

    Parameters
    ----------
    organization_id:
        The tenant's UUID.  Used as a default filter on queries when an
        explicit ``org_id`` is not supplied.
    """

    def __init__(self, organization_id: str | None = None) -> None:
        self.org_id = organization_id or ""
        self.supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        self.supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        try:
            self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        except SupabaseException as e:
            if not self.supabase_url:
                print(
                    "[!] Supabase client could not be created: SUPABASE_URL (or "
                    "NEXT_PUBLIC_SUPABASE_URL) is missing or empty. Set one of them in "
                    "backend-python/.env."
                )
            else:
                print(f"[!] Supabase client could not be created: {e}")
            raise

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get_submissions(
        self,
        *,
        org_id: str | None = None,
        submission_ids: list[str] | None = None,
        status: str = "ready_to_send",
        limit: int = 1,
    ) -> list[dict[str, Any]]:
        """
        Return ``claim_submissions`` rows matching *status* (default
        ``ready_to_send``), optionally filtered by org and/or explicit IDs.

        Parameters
        ----------
        org_id:
            Tenant filter.  When *None* the instance's ``org_id`` is used;
            when that is also empty, no org filter is applied.
        submission_ids:
            If supplied, only rows whose ``id`` is in this list are returned
            (still gated by *status*).
        status:
            Row status to filter on.
        limit:
            Maximum number of rows to return.

        Returns
        -------
        list[dict]
            Raw Supabase row dicts (may include joined ``returns`` rows).
        """
        effective_org = (org_id or self.org_id or "").strip()

        q = (
            self.supabase.table("claim_submissions")
            .select("*, returns(order_id)")
            .eq("status", status)
        )
        if effective_org:
            q = q.eq("organization_id", effective_org)
        if submission_ids:
            q = q.in_("id", submission_ids)
        q = q.limit(limit)

        try:
            response = q.execute()
            return response.data or []
        except Exception as exc:
            _log(f"get_submissions query failed: {type(exc).__name__}: {exc}")
            raise

    def get_submission(
        self,
        submission_id: str,
        organization_id: str | None = None,
    ) -> dict[str, Any] | None:
        """
        Fetch a single ``claim_submissions`` row by its primary key.

        Returns the row dict or *None* when not found.  Never raises on a
        missing row — only re-raises genuine Supabase errors.
        """
        effective_org = (organization_id or self.org_id or "").strip()

        try:
            q = (
                self.supabase.table("claim_submissions")
                .select("*, returns(order_id)")
                .eq("id", submission_id)
            )
            if effective_org:
                q = q.eq("organization_id", effective_org)
            response = q.limit(1).execute()
            rows = response.data or []
            return rows[0] if rows else None
        except Exception as exc:
            _log(f"get_submission failed for {submission_id!r}: {type(exc).__name__}: {exc}")
            raise

    def get_return_for_submission(
        self,
        submission_id: str,
        organization_id: str | None = None,
    ) -> dict[str, Any] | None:
        """
        Fetch the ``returns`` row linked to a ``claim_submissions`` row.

        Uses the existing PostgREST foreign-key embed ``claim_submissions`` →
        ``returns`` (via ``return_id``).  Does not change ``get_submission``;
        uses a narrow select for the join.

        Returns
        -------
        dict | None
            The embedded ``returns`` object with at least ``id``, ``order_id``,
            ``asin``, ``fnsku``, ``sku``, ``lpn`` when present; *None* if the
            submission is missing or has no linked return.
        """
        effective_org = (organization_id or self.org_id or "").strip()
        sid = (submission_id or "").strip()
        if not sid:
            return None

        try:
            q = (
                self.supabase.table("claim_submissions")
                .select("id, returns(id, order_id, asin, fnsku, sku, lpn)")
                .eq("id", sid)
            )
            if effective_org:
                q = q.eq("organization_id", effective_org)
            response = q.limit(1).execute()
            rows = response.data or []
            if not rows:
                return None
            ret = rows[0].get("returns")
            if isinstance(ret, list) and ret:
                ret = ret[0]
            if isinstance(ret, dict):
                return ret
            return None
        except Exception as exc:
            _log(
                f"get_return_for_submission failed for {sid!r}: "
                f"{type(exc).__name__}: {exc}"
            )
            raise

    def get_return_by_id(
        self,
        return_id: str,
        organization_id: str | None = None,
    ) -> dict[str, Any] | None:
        """
        Load a single ``returns`` row by primary key.

        Used when ``claim_submissions.return_id`` is known but the PostgREST
        embed on the submission row is missing or empty.
        """
        effective_org = (organization_id or self.org_id or "").strip()
        rid = (return_id or "").strip()
        if not rid:
            return None
        try:
            q = (
                self.supabase.table("returns")
                .select("id, order_id, asin, fnsku, sku, lpn")
                .eq("id", rid)
            )
            if effective_org:
                q = q.eq("organization_id", effective_org)
            response = q.limit(1).execute()
            rows = response.data or []
            return rows[0] if rows else None
        except Exception as exc:
            _log(
                f"get_return_by_id failed for {rid!r}: {type(exc).__name__}: {exc}"
            )
            raise

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def update_status(self, submission_id: str, status: str) -> None:
        """
        Set ``claim_submissions.status`` for a single row.

        Used for simple state transitions (e.g. marking a row ``failed``
        without a case ID).
        """
        try:
            self.supabase.table("claim_submissions").update({"status": status}).eq(
                "id", submission_id
            ).execute()
            _log(f"update_status: submission_id={submission_id!r} → status={status!r}")
        except Exception as exc:
            _log(
                f"update_status failed for submission_id={submission_id!r}: "
                f"{type(exc).__name__}: {exc}"
            )

    def update_result(
        self,
        submission_id: str,
        amazon_case_id: str | None,
        status: str,
    ) -> None:
        """
        Write the final case status (and case ID when found) to
        ``claim_submissions`` using *submission_id* as the primary key filter.

        This is the canonical "sync after Selenium" call — equivalent to
        ``ClaimProcessorAgent._sync_case_result``.

        Parameters
        ----------
        submission_id:
            ``claim_submissions.id`` of the processed row.
        amazon_case_id:
            The scraped Amazon Case ID, or *None* when not obtained.
        status:
            Final status string (e.g. ``"submitted"``, ``"failed"``).
        """
        update_payload: dict[str, Any] = {"status": status}
        if amazon_case_id:
            update_payload["amazon_case_id"] = amazon_case_id
        try:
            self.supabase.table("claim_submissions").update(update_payload).eq(
                "id", submission_id
            ).execute()
            _log(
                f"update_result: submission_id={submission_id!r} "
                f"status={status!r} amazon_case_id={amazon_case_id!r}"
            )
        except Exception as exc:
            _log(
                f"update_result failed for submission_id={submission_id!r}: "
                f"{type(exc).__name__}: {exc}"
            )

    # ------------------------------------------------------------------
    # Storage / evidence resolution
    # ------------------------------------------------------------------

    def resolve_evidence_pdf_path(self, report_url: str | None) -> str | None:
        """
        Resolve ``claim_submissions.report_url`` to a local file path usable
        for evidence upload.

        Resolution order
        ----------------
        1. *None* / empty / placeholder → return *None* (no upload).
        2. Already a local file path → return its absolute path.
        3. HTTP/HTTPS URL → download to a temp file and return its path.
        4. Supabase Storage object path (bucket ``claim-reports`` by default)
           → download to a temp file and return its path.

        Never raises — a missing or inaccessible PDF is treated as "no upload"
        rather than a hard failure.
        """
        if not report_url or not str(report_url).strip():
            print("[WARNING] No report_url in database; proceeding without PDF upload.", flush=True)
            _log("No report_url; no PDF upload.")
            return None

        p = str(report_url).strip()

        if p.lower() in ("generated_locally", "none", "null"):
            _log(f"report_url is placeholder {p!r}; no PDF upload.")
            return None

        # Already a local file
        if os.path.isfile(p):
            ab = os.path.abspath(p)
            _log(f"Using existing local evidence file: {ab}")
            return ab

        # HTTP/HTTPS download
        if p.startswith("http://") or p.startswith("https://"):
            try:
                import urllib.request
                fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="claim_evidence_")
                os.close(fd)
                _log("Downloading evidence PDF from URL…")
                urllib.request.urlretrieve(p, tmp)
                _log(f"Evidence saved to {tmp}")
                return tmp
            except Exception as exc:
                print(
                    f"[WARNING] Failed to download report URL (continuing without PDF): {exc}",
                    flush=True,
                )
                _log(f"URL download failed: {exc}")
                return None

        # Supabase Storage path
        bucket = (os.getenv("SUPABASE_REPORTS_BUCKET") or "claim-reports").strip()
        try:
            data = self.supabase.storage.from_(bucket).download(p)
            if not data:
                _log(f"Storage download empty for {bucket!r}/{p!r}")
                return None
            fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="claim_evidence_")
            os.close(fd)
            with open(tmp, "wb") as fh:
                fh.write(data)
            _log(f"Downloaded evidence from storage {bucket!r}/{p!r} → {tmp}")
            return tmp
        except Exception as exc:
            print(
                f"[WARNING] Storage PDF download failed (continuing without PDF): {exc}",
                flush=True,
            )
            _log(f"Storage download failed ({bucket!r}/{p!r}): {exc}")
            return None

    # ------------------------------------------------------------------
    # Row-level helpers
    # ------------------------------------------------------------------

    @staticmethod
    def resolve_amazon_order_id_from_row(row: dict[str, Any]) -> str | None:
        """
        Extract the Amazon Order ID from a ``claim_submissions`` row dict.

        Checks (in order):
        1. ``source_payload.amazon_order_id``
        2. ``source_payload.amazonOrderId``
        3. ``source_payload.order_id``
        4. ``returns[0].order_id``

        Returns the first non-empty string found, or *None*.
        """
        payload = row.get("source_payload")
        if isinstance(payload, dict):
            for key in ("amazon_order_id", "amazonOrderId", "order_id"):
                v = payload.get(key)
                if isinstance(v, str) and v.strip():
                    oid = v.strip()
                    _log(f"Resolved amazon_order_id from source_payload.{key}: {oid!r}")
                    return oid

        ret = row.get("returns")
        if isinstance(ret, list) and ret:
            ret = ret[0]
        if isinstance(ret, dict):
            oid = ret.get("order_id")
            if isinstance(oid, str) and oid.strip():
                s = oid.strip()
                _log(f"Resolved amazon_order_id from returns.order_id: {s!r}")
                return s

        _log("Could not resolve amazon_order_id from database row.")
        return None
