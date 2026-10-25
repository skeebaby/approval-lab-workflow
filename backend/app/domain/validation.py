from collections.abc import Iterable

from app.models.workflow import GroupRule, NOfMRule, RoleRule, Workflow


def _rule_errors(rule: object, eligible_roles: set[str], path: str) -> list[str]:
    if isinstance(rule, RoleRule):
        if rule.role not in eligible_roles:
            return [f'{path} references non-approver "{rule.role}".']
        return []
    if isinstance(rule, NOfMRule):
        errors = []
        if rule.m < rule.n:
            errors.append(f"{path} has an invalid N-of-M threshold.")
        if rule.m > len(eligible_roles):
            errors.append(f"{path} requires more approvers than the stage contains.")
        return errors
    if isinstance(rule, GroupRule):
        if not rule.rules:
            return [f"{path} must contain at least one child rule."]
        return [
            error
            for index, child in enumerate(rule.rules, start=1)
            for error in _rule_errors(child, eligible_roles, f"{path}, rule {index}")
        ]
    return [f"{path} has an unsupported rule."]


def validate_workflow(workflow: Workflow) -> list[str]:
    errors: list[str] = []
    if not workflow.name.strip():
        errors.append("A workflow name is required.")
    if not workflow.asset_type.strip():
        errors.append("An asset type is required.")
    if not workflow.owner.strip():
        errors.append("A workflow owner is required.")
    if not workflow.stages:
        errors.append("Add at least one review stage.")

    stage_ids = {stage.id for stage in workflow.stages}
    if len(stage_ids) != len(workflow.stages):
        errors.append("Stage ids must be unique.")
    for index, stage in enumerate(workflow.stages, start=1):
        label = f"Stage {index}"
        eligible_roles = {
            participant.role
            for participant in stage.participants
            if participant.participation == "approver"
        }
        eligible_roles.update(
            condition.role
            for condition in workflow.conditions
            if condition.stage_id == stage.id and condition.participation == "approver"
        )
        if not eligible_roles:
            errors.append(f"{label} needs at least one approver or conditional approver.")
        if not stage.time_limit:
            errors.append(f"{label} needs a time limit.")
        errors.extend(_rule_errors(stage.approval_rule, eligible_roles, f"{label} approval rule"))
        for participant in stage.participants:
            if not participant.role.strip():
                errors.append(f"{label} has a participant without a role.")

    for condition in workflow.conditions:
        if condition.stage_id not in stage_ids:
            errors.append(f'Condition "{condition.condition}" references a missing stage.')
        elif condition.effect == "change-participation":
            stage = next(stage for stage in workflow.stages if stage.id == condition.stage_id)
            if not any(person.role == condition.role for person in stage.participants):
                errors.append(
                    f'Condition "{condition.condition}" changes participation for a missing participant.'
                )

    for stage in workflow.stages:
        for condition_name in stage.applies_when or []:
            if not any(condition.condition == condition_name for condition in workflow.conditions):
                errors.append(f'Stage "{stage.name}" references an unknown apply condition.')

    return errors


def require_valid_for_confirmation(workflow: Workflow) -> None:
    errors = validate_workflow(workflow)
    if workflow.unresolved_questions:
        errors.append("Resolve all clarification questions before confirming.")
    if errors:
        raise ValueError(" ".join(errors))
