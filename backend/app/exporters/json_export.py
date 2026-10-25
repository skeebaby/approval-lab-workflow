from app.models.workflow import Workflow
from app.domain.validation import validate_workflow


def workflow_json(workflow: Workflow) -> dict:
    if workflow.status != "confirmed" or not workflow.confirmed_at:
        raise ValueError("Only a confirmed workflow can be exported.")
    if workflow.unresolved_questions:
        raise ValueError("The confirmed workflow still has unresolved questions.")
    if validate_workflow(workflow):
        raise ValueError("The confirmed workflow is no longer valid.")
    return workflow.model_dump(mode="json", by_alias=True, exclude_none=True)
