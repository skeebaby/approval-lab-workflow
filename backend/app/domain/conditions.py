from app.models.workflow import Participant, Workflow


def apply_conditions(workflow: Workflow, active_conditions: set[str]) -> dict[str, list[Participant]]:
    """Return effective participant lists without mutating the canonical draft."""
    participants_by_stage = {
        stage.id: [participant.model_copy(deep=True) for participant in stage.participants]
        for stage in workflow.stages
    }
    for condition in workflow.conditions:
        if condition.condition not in active_conditions:
            continue
        participants = participants_by_stage.get(condition.stage_id)
        if participants is None:
            continue
        if condition.effect == "change-participation":
            existing = next((person for person in participants if person.role == condition.role), None)
            if existing:
                existing.participation = condition.participation
            continue
        if not any(person.role == condition.role for person in participants):
            participants.append(Participant(role=condition.role, participation=condition.participation))
    return participants_by_stage
