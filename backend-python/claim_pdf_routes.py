"""FastAPI routes for claim evidence PDF generation (reportlab)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from claim_report_service import generate_claim_evidence_pdf


def _claim_pdf_api_enabled() -> bool:
    """Default deny — set CLAIM_PDF_API_ENABLED=1 only with operator approval."""
    return os.getenv("CLAIM_PDF_API_ENABLED", "0").strip().lower() in ("1", "true", "yes")


class GenerateClaimEvidencePdfRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    submission_id: str | None = None
    claim_data: dict | None = None
    upload_to_storage: bool = True
    storage_bucket: str = "claim-reports"


def register_claim_pdf_routes(app: Any) -> None:
    @app.post("/claims/generate-evidence-pdf")
    async def claims_generate_evidence_pdf(body: GenerateClaimEvidencePdfRequest) -> dict:
        if not _claim_pdf_api_enabled():
            raise HTTPException(
                status_code=403,
                detail="CLAIM_PDF_API_ENABLED is off (default). Enable only with operator approval.",
            )
        if not body.submission_id and not body.claim_data:
            raise HTTPException(
                status_code=400,
                detail="submission_id is required when claim_data is not provided.",
            )
        result = generate_claim_evidence_pdf(
            organization_id=body.organization_id.strip(),
            submission_id=body.submission_id,
            claim_data=body.claim_data,
            upload_to_storage=body.upload_to_storage,
            storage_bucket=body.storage_bucket,
        )
        if not result.get("ok"):
            raise HTTPException(status_code=500, detail=result.get("error") or "PDF generation failed")
        return result
