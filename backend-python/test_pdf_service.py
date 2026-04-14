# test_pdf_service.py

from claim_report_service import generate_claim_evidence_pdf

ORG_ID = "00000000-0000-0000-0000-000000000001"
SUBMISSION_ID = "6bffd14b-1490-45a2-9b91-bc61b653cbae"


def main() -> None:
    print("=== TEST 1: local PDF only ===")
    result_local = generate_claim_evidence_pdf(
        organization_id=ORG_ID,
        submission_id=SUBMISSION_ID,
        upload_to_storage=False,
    )
    print(result_local)

    print("\n=== TEST 2: local PDF + storage upload ===")
    result_upload = generate_claim_evidence_pdf(
        organization_id=ORG_ID,
        submission_id=SUBMISSION_ID,
        upload_to_storage=True,
    )
    print(result_upload)


if __name__ == "__main__":
    main()