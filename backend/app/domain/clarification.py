from app.models.workflow import Workflow
from app.domain.validation import validate_workflow


def clarification_status(workflow: Workflow) -> str:
    if workflow.unresolved_questions:
        return "needs_clarification"
    if validate_workflow(workflow):
        return "draft"
    return "ready_for_review"
