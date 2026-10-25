import re
from copy import deepcopy
from uuid import uuid4

from app.models.workflow import (
    ConversationMessage,
    GroupRule,
    Participant,
    RoleRule,
    Stage,
    TimeLimit,
    Workflow,
    WorkflowCondition,
    utc_now,
)
from app.domain.registry import ASSET_TYPES, CONDITIONS, ROLES
from app.domain.clarification import clarification_status
NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "eight": 8,
    "twelve": 12,
}
TIME_PATTERN = re.compile(
    r"\b(\d+(?:\.\d+)?|one|two|three|four|five|eight|twelve)\s*"
    r"(hours?|business[- ]days?|days?)\b",
    re.IGNORECASE,
)


def _time_limit(message: str, scope_pattern: re.Pattern[str]) -> TimeLimit | None:
    match = scope_pattern.search(message)
    if not match:
        return None
    time_match = TIME_PATTERN.search(message[match.end() : match.end() + 50])
    if not time_match:
        return None
    raw_amount, raw_unit = time_match.groups()
    amount = float(raw_amount) if raw_amount[0].isdigit() else NUMBER_WORDS[raw_amount.lower()]
    return TimeLimit(amount=amount, unit="hours" if "hour" in raw_unit.lower() else "business-days")


def _mentioned_roles(message: str) -> list[str]:
    lowered = message.lower()
    return sorted(
        (role for role in ROLES if role.lower() in lowered),
        key=lambda role: lowered.index(role.lower()),
    )


def _replace_stage_with_approvers(workflow: Workflow, roles: list[str], rule_type: str) -> list[Stage]:
    stages = deepcopy(workflow.stages)
    stage = stages[-1] if stages else Stage(
        id=str(uuid4()),
        position=1,
        name="Review",
        participants=[],
        approval_rule=GroupRule(
            type=rule_type,
            rules=[RoleRule(type="role", role=role) for role in roles],
        ),
    )
    existing = {participant.role: participant for participant in stage.participants}
    for role in roles:
        if role in existing:
            existing[role].participation = "approver"
        else:
            stage.participants.append(Participant(role=role, participation="approver"))
    stage.approval_rule = GroupRule(
        type=rule_type,
        rules=[RoleRule(type="role", role=role) for role in roles],
    )
    if not stages:
        stages.append(stage)
    return stages


def _clarify_time_conflict(
    workflow: Workflow,
    scope: str,
    stage_id: str,
    previous: TimeLimit,
    candidate: TimeLimit,
) -> str:
    return (
        f"Time limit conflict|{scope}|{stage_id}|{previous.amount}|{previous.unit}|"
        f"{candidate.amount}|{candidate.unit}"
    )


def process_message(workflow: Workflow, content: str) -> Workflow:
    message = content.strip()
    if not message:
        raise ValueError("Message content cannot be empty.")
    now = utc_now()
    candidate = workflow.model_copy(deep=True)
    candidate.conversation.append(ConversationMessage(role="user", content=message, created_at=now))
    questions = list(candidate.unresolved_questions)

    approval_question = next(
        (question for question in questions if question.startswith(("Approval rule:", "Approval conflict:"))),
        None,
    )
    if approval_question:
        preserve_existing = approval_question.startswith("Approval conflict:") and re.search(
            r"\b(keep|existing|previous|original)\b", message, re.IGNORECASE
        )
        if preserve_existing:
            questions.remove(approval_question)
        elif re.search(r"\b(all|any|either)\b", message, re.IGNORECASE):
            _, raw_roles, *_ = approval_question.split(":")
            roles = [role.strip() for role in raw_roles.split(",") if role.strip()]
            rule_type = "any" if re.search(r"\b(any|either)\b", message, re.IGNORECASE) else "all"
            candidate.stages = _replace_stage_with_approvers(candidate, roles, rule_type)
            questions.remove(approval_question)

    time_question = next(
        (question for question in questions if question.startswith("Time limit conflict|")),
        None,
    )
    if time_question:
        answer_new = bool(re.search(r"\b(new|updated|second|latest)\b", message, re.IGNORECASE))
        answer_old = bool(re.search(r"\b(old|previous|existing|original|keep)\b", message, re.IGNORECASE))
        if answer_new or answer_old:
            _, scope, stage_id, old_amount, old_unit, new_amount, new_unit = time_question.split("|")
            selected = TimeLimit(
                amount=float(new_amount if answer_new else old_amount),
                unit=new_unit if answer_new else old_unit,
            )
            if scope == "intake":
                candidate.intake_time_limit = selected
            elif scope == "final":
                candidate.final_decision_time_limit = selected
            elif scope == "total":
                candidate.total_time_limit = selected
            elif scope == "stage":
                candidate.stages = [
                    stage.model_copy(update={"time_limit": selected}) if stage.id == stage_id else stage
                    for stage in candidate.stages
                ]
            questions.remove(time_question)

    lowered = message.lower()
    asset_type = next((value for value in ASSET_TYPES if value.lower() in lowered), None)
    if asset_type:
        candidate.asset_type = asset_type

    scope_patterns = {
        "intake": re.compile(r"\bintake\b", re.IGNORECASE),
        "final": re.compile(r"\bfinal decision\b", re.IGNORECASE),
        "total": re.compile(r"\b(total|overall|entire)\s+(workflow|process|limit|deadline)?", re.IGNORECASE),
        "stage": re.compile(r"\b(stage|review)\b", re.IGNORECASE),
    }
    for scope, pattern in scope_patterns.items():
        limit = _time_limit(message, pattern)
        if not limit:
            continue
        if scope == "intake":
            previous = candidate.intake_time_limit
            if previous and previous != limit:
                question = _clarify_time_conflict(candidate, scope, "", previous, limit)
            else:
                candidate.intake_time_limit = limit
                question = ""
        elif scope == "final":
            previous = candidate.final_decision_time_limit
            if previous and previous != limit:
                question = _clarify_time_conflict(candidate, scope, "", previous, limit)
            else:
                candidate.final_decision_time_limit = limit
                question = ""
        elif scope == "total":
            previous = candidate.total_time_limit
            if previous and previous != limit:
                question = _clarify_time_conflict(candidate, scope, "", previous, limit)
            else:
                candidate.total_time_limit = limit
                question = ""
        elif not candidate.stages:
            question = "Which review stage should this time limit apply to?"
        else:
            stage = candidate.stages[-1]
            if stage.time_limit and stage.time_limit != limit:
                question = _clarify_time_conflict(candidate, scope, stage.id, stage.time_limit, limit)
            else:
                candidate.stages[-1] = stage.model_copy(update={"time_limit": limit})
                question = ""
        if question and question not in questions:
            questions.append(question)
        elif not question:
            questions = [
                item for item in questions
                if not (item.startswith(f"Time limit conflict|{scope}|") or item == "Which review stage should this time limit apply to?")
            ]

    approval_match = re.search(r"\b(approve|approves|approval|sign(?:s)? off)\b", message, re.IGNORECASE)
    if approval_match:
        approval_prefix = message[:approval_match.start()]
        clause_start = max(approval_prefix.rfind("."), approval_prefix.rfind(";"), approval_prefix.rfind("\n"))
        approval_clause = message[clause_start + 1 :]
        roles = _mentioned_roles(approval_clause)
    else:
        roles = []
    if len(roles) > 1 and approval_match:
        approval_text = message[approval_match.start() :].lower()
        requested_rule = (
            "any" if re.search(r"\b(either|any one|or)\b", approval_text, re.IGNORECASE)
            else "all" if re.search(r"\b(all|both|each|must)\b", message, re.IGNORECASE)
            else None
        )
        previous_roles = set()
        previous_type = None
        if candidate.stages:
            previous_roles = {
                participant.role
                for participant in candidate.stages[-1].participants
                if participant.participation == "approver"
            }
            if isinstance(candidate.stages[-1].approval_rule, GroupRule):
                previous_type = candidate.stages[-1].approval_rule.type
        if requested_rule is None:
            question = f"Approval rule:{','.join(roles)}"
            if question not in questions:
                questions.append(question)
        elif candidate.stages and (set(roles) != previous_roles or requested_rule != previous_type):
            question = f"Approval conflict:{','.join(roles)}:{previous_type or 'other'}:{requested_rule}"
            if question not in questions:
                questions.append(question)
        else:
            candidate.stages = _replace_stage_with_approvers(candidate, roles, requested_rule)
    elif len(roles) == 1 and approval_match:
        role = roles[0]
        if candidate.stages:
            candidate.stages = _replace_stage_with_approvers(candidate, roles, "all")
            candidate.stages[-1].approval_rule = RoleRule(type="role", role=role)
        else:
            candidate.stages = [Stage(
                id=str(uuid4()),
                position=1,
                name="Review",
                participants=[Participant(role=role, participation="approver")],
                approval_rule=RoleRule(type="role", role=role),
            )]
    condition = next((value for value in CONDITIONS if value.lower() in lowered), None)
    conditional_role = next(
        (role for role in ("Outside Counsel", "Player Agent", "Venue Owner", "League Office") if role in roles),
        None,
    )
    if condition and conditional_role and re.search(r"\b(when|if|only if)\b", message, re.IGNORECASE) and candidate.stages:
        target = next(
            (stage for stage in candidate.stages if "legal" in stage.name.lower() and conditional_role == "Outside Counsel"),
            next((stage for stage in candidate.stages if "external" in stage.name.lower()), candidate.stages[-1]),
        )
        participation = "consultative" if re.search(r"\b(advises|advice|consultative)\b", message, re.IGNORECASE) else "approver"
        candidate.conditions = [
            item for item in candidate.conditions
            if not (item.condition == condition and item.role == conditional_role)
        ]
        candidate.conditions.append(
            WorkflowCondition(
                id=str(uuid4()),
                condition=condition,
                effect="add-participant",
                role=conditional_role,
                participation=participation,
                stage_id=target.id,
            )
        )

    candidate.unresolved_questions = questions
    candidate.status = "needs_clarification" if questions else clarification_status(candidate)
    candidate.confirmed_at = None
    candidate.updated_at = utc_now()

    new_question = next((item for item in questions if item not in workflow.unresolved_questions), None)
    if new_question and new_question.startswith(("Approval rule:", "Approval conflict:")):
        names = new_question.split(":")[1].replace(",", ", ")
        response = f"Should {names} all approve, or is any one sufficient?"
    elif new_question and new_question.startswith("Time limit conflict|"):
        response = "This message gives a different time limit than an earlier message. Reply “keep the existing value” or “use the new value”."
    elif new_question:
        response = new_question
    else:
        response = (
            "I added the clear facts I could identify. Review the workflow and correct anything missed; "
            "extraction is rule-based and may not recognize every phrasing."
        )
    candidate.conversation.append(
        ConversationMessage(role="assistant", content=response, created_at=utc_now())
    )
    return candidate
