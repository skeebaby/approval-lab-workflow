from app.models.workflow import Workflow


def merge_workflow(current: Workflow, candidate: Workflow) -> Workflow:
    """Merge explicit structured edits while retaining server-owned lifecycle fields."""
    return candidate.model_copy(
        update={
            "id": current.id,
            "created_at": current.created_at,
            "version": current.version,
            "status": current.status,
            "confirmed_at": current.confirmed_at,
            "updated_at": current.updated_at,
        }
    )
