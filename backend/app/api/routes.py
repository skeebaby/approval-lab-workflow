import json
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Response

from app.domain.clarification import clarification_status
from app.domain.merge import merge_workflow
from app.domain.validation import require_valid_for_confirmation, validate_workflow
from app.domain.workflow_factory import new_workflow
from app.exporters.json_export import workflow_json
from app.exporters.pdf_export import export_pdf
from app.extraction.adapter import process_message
from app.extraction.llm_parser import LLMExtractionError
from app.models.workflow import MessageRequest, Workflow, WorkflowPatch, utc_now
from app.persistence import repository

router = APIRouter(prefix="/api")
EXAMPLES_PATH = Path(__file__).resolve().parents[3] / "examples"


def _load(workflow_id: str) -> Workflow:
    workflow = repository.get(workflow_id)
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found.")
    return workflow


def _workflow_response(workflow: Workflow) -> dict:
    return workflow.model_dump(mode="json", by_alias=True, exclude_none=True)


@router.post("/workflows")
def create_workflow(workflow: Workflow | None = None):
    draft = workflow or new_workflow()
    draft = draft.model_copy(update={
        "id": str(uuid4()),
        "version": 1,
        "status": "ready_for_review" if draft.stages else "draft",
        "confirmed_at": None,
        "updated_at": utc_now(),
    })
    repository.save(draft)
    return _workflow_response(draft)


@router.get("/workflows")
def list_workflows():
    return [
        {
            "id": workflow.id,
            "name": workflow.name,
            "assetType": workflow.asset_type,
            "status": workflow.status,
            "updatedAt": workflow.updated_at.isoformat(),
        }
        for workflow in repository.list_all()
    ]


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str):
    return _workflow_response(_load(workflow_id))


@router.post("/workflows/{workflow_id}/messages")
def add_message(workflow_id: str, request: MessageRequest):
    try:
        updated = process_message(_load(workflow_id), request.content)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except LLMExtractionError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    repository.save(updated)
    return _workflow_response(updated)


@router.patch("/workflows/{workflow_id}")
def patch_workflow(workflow_id: str, payload: WorkflowPatch):
    current = _load(workflow_id)
    merged = merge_workflow(current, payload)
    now = utc_now()
    updated = merged.model_copy(update={
        "version": current.version + (1 if current.status == "confirmed" else 0),
        "status": clarification_status(merged),
        "confirmed_at": None,
        "updated_at": now,
    })
    repository.save(updated)
    return _workflow_response(updated)


@router.post("/workflows/{workflow_id}/confirm")
def confirm_workflow(workflow_id: str):
    workflow = _load(workflow_id)
    try:
        require_valid_for_confirmation(workflow)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    now = utc_now()
    confirmed = workflow.model_copy(update={
        "status": "confirmed",
        "confirmed_at": now,
        "updated_at": now,
    })
    repository.save(confirmed)
    return _workflow_response(confirmed)


@router.get("/workflows/{workflow_id}/export/json")
def export_json(workflow_id: str):
    workflow = _load(workflow_id)
    try:
        payload = workflow_json(workflow)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(
        content=json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{workflow.id}-v{workflow.version}.json"'},
    )


@router.get("/workflows/{workflow_id}/export/pdf")
def export_workflow_pdf(workflow_id: str):
    try:
        content = export_pdf(_load(workflow_id))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{workflow_id}.pdf"'},
    )


@router.get("/examples/{example_id}")
def get_example(example_id: str):
    if example_id not in {"experience_promos", "social_digital"}:
        raise HTTPException(status_code=404, detail="Example not found.")
    path = EXAMPLES_PATH / example_id / "workflow.json"
    try:
        workflow = Workflow.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail="The configured workflow example could not be loaded.") from error
    return _workflow_response(workflow)
