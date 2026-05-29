"""FastAPI routes for Amazon Seller Central claim filing automation (staging-gated)."""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import Body, HTTPException
from pydantic import BaseModel, Field

from claim_agent import ClaimProcessorAgent
from claim_agent_constants import CLAIM_SUBMISSIONS_WITH_RETURN_ITEM
from claim_agent_guards import (
    assert_claim_agent_preflight,
    claim_agent_enabled,
    claim_browser_engine,
    claim_browser_execute_allowed,
)
from claim_repository import ClaimRepository
from claim_report_service import generate_claim_evidence_pdf


class ProcessReadyClaimsRequest(BaseModel):
    organization_id: str | None = Field(
        default=None,
        description="Tenant filter; falls back to CLAIM_AGENT_ORGANIZATION_ID env.",
    )
    submission_ids: list[str] | None = None
    limit: int = Field(default=1, ge=1, le=50)


def _default_org_for_agent() -> str | None:
    raw = (os.getenv("CLAIM_AGENT_ORGANIZATION_ID") or "").strip()
    return raw or None


def _enrich_submission_row(repo: ClaimRepository, row: dict[str, Any]) -> dict[str, Any]:
    """Attach return_items / claim_lines context without legacy returns embed."""
    out = dict(row)
    rid = str(row.get("return_id") or "").strip()
    if rid and not out.get("return_items"):
        item = repo.get_return_for_submission(str(row.get("id") or ""), row.get("organization_id"))
        if item:
            out["return_items"] = item
    if rid:
        line = repo.get_claim_line_for_return_item(rid, row.get("organization_id"))
        if line:
            out["claim_lines"] = line
    return out


def _resolve_evidence_pdf(row: dict, org: str) -> str | None:
    result = generate_claim_evidence_pdf(
        organization_id=org,
        submission_id=str(row.get("id") or ""),
        claim_data=row,
        upload_to_storage=False,
    )
    if result.get("ok") and result.get("local_pdf_path"):
        return str(result["local_pdf_path"])
    return None


def register_claim_agent_routes(app: Any) -> None:
    @app.get("/agent/pending-claims")
    async def get_pending_claims() -> dict:
        if not claim_agent_enabled():
            raise HTTPException(status_code=403, detail="CLAIM_AGENT_ENABLED is off (default).")
        assert_claim_agent_preflight()
        repo = ClaimRepository(_default_org_for_agent())
        rows = repo.get_submissions(status="ready_to_send", limit=50)
        return {"count": len(rows), "claims": rows}

    @app.post("/agent/process-ready-claims")
    async def process_ready_claims(
        organization_id: str | None = Body(default=None),
        submission_ids: list[str] | None = Body(default=None),
        limit: int = Body(default=1, ge=1, le=50),
    ) -> dict:
        if not claim_agent_enabled():
            raise HTTPException(
                status_code=403,
                detail="CLAIM_AGENT_ENABLED is off. Enable only on staging with operator approval.",
            )
        assert_claim_agent_preflight()

        dry_run = not claim_browser_execute_allowed()
        req = ProcessReadyClaimsRequest(
            organization_id=organization_id,
            submission_ids=submission_ids,
            limit=limit,
        )
        org = (req.organization_id or "").strip() or _default_org_for_agent() or ""
        repo = ClaimRepository(org or None)

        q = (
            repo.supabase.table("claim_submissions")
            .select(CLAIM_SUBMISSIONS_WITH_RETURN_ITEM)
            .eq("status", "ready_to_send")
        )
        if org:
            q = q.eq("organization_id", org)
        if req.submission_ids:
            q = q.in_("id", req.submission_ids)
        rows = (q.limit(req.limit).execute()).data or []

        if not rows:
            return {
                "ok": True,
                "processed": 0,
                "dry_run": dry_run,
                "message": "No ready_to_send claims matched.",
                "results": [],
            }

        results: list[dict] = []
        for raw in rows:
            row = _enrich_submission_row(repo, raw)
            submission_id = row.get("id")
            row_org = str(row.get("organization_id") or org or "").strip()
            amazon_order_id = ClaimRepository.resolve_amazon_order_id_from_row(row)
            if not amazon_order_id:
                results.append(
                    {
                        "submission_id": submission_id,
                        "ok": False,
                        "error": "Could not resolve amazon_order_id.",
                    }
                )
                continue

            if dry_run:
                pdf_path = None
                try:
                    pdf_path = _resolve_evidence_pdf(row, row_org)
                except Exception as exc:
                    results.append(
                        {
                            "submission_id": submission_id,
                            "ok": True,
                            "dry_run": True,
                            "amazon_order_id": amazon_order_id,
                            "pdf_generated": False,
                            "detail": f"PDF dry-run error: {exc}",
                        }
                    )
                    continue
                results.append(
                    {
                        "submission_id": submission_id,
                        "ok": True,
                        "dry_run": True,
                        "amazon_order_id": amazon_order_id,
                        "pdf_generated": bool(pdf_path),
                        "browser_engine": claim_browser_engine(),
                        "detail": "CLAIM_AGENT_EXECUTE_BROWSER=0 — no Seller Central filing.",
                    }
                )
                continue

            payload = row.get("source_payload") or {}
            claim_type = str(payload.get("claim_type") or "FBA_CLAIM")
            try:
                agent = ClaimProcessorAgent(row_org)
            except Exception as e:
                results.append({"submission_id": submission_id, "ok": False, "error": f"Agent init failed: {e}"})
                continue

            pdf_path = _resolve_evidence_pdf(row, row_org)

            def run_one() -> tuple[bool, Any]:
                local_pdf = pdf_path
                try:
                    outcome = agent.run_selenium_navigation(
                        amazon_order_id=amazon_order_id,
                        claim_type=claim_type,
                        evidence_pdf_path=local_pdf,
                        submission_id=submission_id,
                        claim_data=row,
                    )
                    return (outcome is not None, outcome)
                finally:
                    if local_pdf and os.path.isfile(local_pdf):
                        try:
                            os.remove(local_pdf)
                        except OSError:
                            pass

            ok, message = await asyncio.to_thread(run_one)
            if ok and isinstance(message, dict):
                new_status = message.get("status", "submitted")
                scraped_case_id = message.get("amazon_case_id")
            else:
                new_status = "failed"
                scraped_case_id = None
                try:
                    repo.update_status(str(submission_id), new_status)
                except Exception:
                    pass

            results.append(
                {
                    "submission_id": submission_id,
                    "ok": ok,
                    "dry_run": False,
                    "amazon_order_id": amazon_order_id,
                    "amazon_case_id": scraped_case_id,
                    "status_updated": new_status,
                    "detail": message.get("message") if isinstance(message, dict) else message,
                }
            )

        return {"ok": True, "processed": len(results), "dry_run": dry_run, "results": results}
