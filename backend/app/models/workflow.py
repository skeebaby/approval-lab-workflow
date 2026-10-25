from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class WorkflowModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        validate_assignment=True,
    )


class TimeLimit(WorkflowModel):
    amount: float = Field(gt=0)
    unit: Literal["hours", "business-days"]


class Participant(WorkflowModel):
    role: str = Field(min_length=1)
    participation: Literal["approver", "consultative", "viewer"]
    organization_type: Literal["Property", "outside organization", "custom"] | None = None
    notes: str | None = None
    source_evidence: str | None = None


class RoleRule(WorkflowModel):
    type: Literal["role"]
    role: str = Field(min_length=1)


class GroupRule(WorkflowModel):
    type: Literal["all", "any"]
    rules: list["ApprovalRule"] = Field(min_length=1)


class NOfMRule(WorkflowModel):
    type: Literal["n_of_m"]
    n: int = Field(ge=1)
    m: int = Field(ge=1)


ApprovalRule = Annotated[RoleRule | GroupRule | NOfMRule, Field(discriminator="type")]
GroupRule.model_rebuild()


class Stage(WorkflowModel):
    id: str = Field(min_length=1)
    position: int = Field(ge=1)
    name: str = Field(min_length=1)
    time_limit: TimeLimit | None = None
    participants: list[Participant]
    approval_rule: ApprovalRule
    applies_when: list[str] | None = None


class WorkflowCondition(WorkflowModel):
    id: str = Field(min_length=1)
    condition: str = Field(min_length=1)
    effect: Literal["add-participant", "change-participation"]
    role: str = Field(min_length=1)
    participation: Literal["approver", "consultative", "viewer"]
    stage_id: str = Field(min_length=1)


class ConversationMessage(WorkflowModel):
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime = Field(default_factory=utc_now)


WorkflowStatus = Literal["draft", "needs_clarification", "ready_for_review", "confirmed"]


class Workflow(WorkflowModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    asset_type: str = Field(min_length=1)
    owner: str = Field(min_length=1)
    intake_time_limit: TimeLimit | None = None
    stages: list[Stage]
    final_decision_time_limit: TimeLimit | None = None
    total_time_limit: TimeLimit | None = None
    viewers: list[str]
    conditions: list[WorkflowCondition]
    notes: list[str]
    assumptions: list[str]
    unresolved_questions: list[str]
    conversation: list[ConversationMessage]
    status: WorkflowStatus = "draft"
    version: int = Field(ge=1)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    confirmed_at: datetime | None = None

    @model_validator(mode="after")
    def validate_stage_positions(self) -> "Workflow":
        positions = [stage.position for stage in self.stages]
        if len(positions) != len(set(positions)):
            raise ValueError("Stage positions must be unique.")
        if positions and positions != list(range(1, len(positions) + 1)):
            raise ValueError("Stage positions must be ordered from one.")
        return self


class MessageRequest(WorkflowModel):
    content: str = Field(min_length=1)


class WorkflowPatch(Workflow):
    pass
