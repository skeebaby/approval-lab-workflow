from app.models.workflow import GroupRule, NOfMRule, RoleRule


def eligible_approvers(stage, conditions=()) -> set[str]:
    roles = {
        participant.role
        for participant in stage.participants
        if participant.participation == "approver"
    }
    roles.update(
        condition.role
        for condition in conditions
        if condition.stage_id == stage.id and condition.participation == "approver"
    )
    return roles


def rule_roles(rule) -> set[str]:
    if isinstance(rule, RoleRule):
        return {rule.role}
    if isinstance(rule, NOfMRule):
        return set()
    if isinstance(rule, GroupRule):
        return set().union(*(rule_roles(child) for child in rule.rules))
    return set()
