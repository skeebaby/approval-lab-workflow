from uuid import uuid4

from app.models.workflow import Workflow, utc_now


def new_workflow(asset_type: str = "Experience & Promos") -> Workflow:
    timestamp = utc_now()
    return Workflow(
        id=str(uuid4()),
        name="New approval workflow",
        asset_type=asset_type,
        owner="Partnership Lead",
        stages=[],
        viewers=[],
        conditions=[],
        notes=[],
        assumptions=[],
        unresolved_questions=[],
        conversation=[],
        status="draft",
        version=1,
        created_at=timestamp,
        updated_at=timestamp,
    )
