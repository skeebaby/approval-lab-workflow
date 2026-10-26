import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.domain.validation import validate_workflow
from app.domain.conditions import apply_conditions
from app.extraction.adapter import process_message
from app.extraction import llm_parser
from app.main import app
from app.models.workflow import GroupRule, RoleRule, Workflow, WorkflowCondition
from app.persistence import repository


ROOT = Path(__file__).resolve().parents[2]


def load_example(name: str) -> Workflow:
    return Workflow.model_validate_json(
        (ROOT / "examples" / name / "workflow.json").read_text(encoding="utf-8")
    )


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(repository, "DATABASE_PATH", tmp_path / "workflows.db")
    repository.initialize()
    with TestClient(app) as test_client:
        yield test_client


def test_challenge_examples_validate():
    assert validate_workflow(load_example("experience_promos")) == []
    assert validate_workflow(load_example("social_digital")) == []

def test_api_creates_an_empty_draft_without_request_body(client):
    response = client.post("/api/workflows")
    assert response.status_code == 200
    assert response.json()["status"] == "draft"
    assert response.json()["stages"] == []


def test_workflow_list_includes_draft_ready_and_confirmed_workflows(client):
    draft = client.post("/api/workflows").json()
    ready = client.post(
        "/api/workflows",
        json=load_example("social_digital").model_dump(mode="json", by_alias=True),
    ).json()
    confirmed = client.post(
        "/api/workflows",
        json=load_example("social_digital").model_dump(mode="json", by_alias=True),
    ).json()
    confirmed = client.post(f"/api/workflows/{confirmed['id']}/confirm").json()

    response = client.get("/api/workflows")

    assert response.status_code == 200
    workflows = {item["id"]: item for item in response.json()}
    assert workflows[draft["id"]]["status"] == "draft"
    assert workflows[ready["id"]]["status"] == "ready_for_review"
    assert workflows[confirmed["id"]]["status"] == "confirmed"
    assert workflows[ready["id"]]["name"] == ready["name"]
    assert workflows[ready["id"]]["assetType"] == ready["assetType"]


def test_validation_checks_nested_rules_and_conditional_approvers():
    workflow = load_example("social_digital")
    workflow.stages[0].approval_rule = {
        "type": "all",
        "rules": [
            {"type": "role", "role": "Social/Digital"},
            {
                "type": "any",
                "rules": [
                    {"type": "role", "role": "Marketing"},
                    {"type": "role", "role": "Ownership"},
                ],
            },
        ],
    }
    assert any("Ownership" in error for error in validate_workflow(workflow))

    workflow.conditions = [*workflow.conditions, WorkflowCondition.model_validate({
        "id": "conditional-ownership",
        "condition": "Sensitivity",
        "effect": "add-participant",
        "role": "Ownership",
        "participation": "approver",
        "stageId": workflow.stages[0].id,
    })]
    assert validate_workflow(workflow) == []

def test_n_of_m_rules_validate_thresholds():
    workflow = load_example("social_digital")
    workflow.stages[0].approval_rule = {"type": "n_of_m", "n": 2, "m": 2}
    assert validate_workflow(workflow) == []
    workflow.stages[0].approval_rule = {"type": "n_of_m", "n": 3, "m": 2}
    assert "Stage 1 approval rule has an invalid N-of-M threshold." in validate_workflow(workflow)


def test_conditions_promote_and_add_participants_without_mutating_draft():
    workflow = load_example("experience_promos")
    effective = apply_conditions(workflow, {"Uses a player’s likeness"})
    contest_effective = apply_conditions(
        workflow,
        {"Includes legal, contest or sweepstakes language"},
    )
    legal_participants = {person.role: person.participation for person in effective["legal-review"]}
    external_participants = {person.role for person in effective["external-approvals"]}

    assert legal_participants["Player Personnel"] == "approver"
    assert "Player Agent" in external_participants
    assert {
        person.role: person.participation for person in contest_effective["legal-review"]
    }["Outside Counsel"] == "consultative"
    original_player_personnel = next(
        person for person in workflow.stages[1].participants if person.role == "Player Personnel"
    )
    assert original_player_personnel.participation == "consultative"


def test_conversation_merges_facts_and_asks_for_ambiguous_rule():
    workflow = load_example("social_digital")
    workflow.stages = []
    workflow.conditions = []
    workflow.intake_time_limit = None
    workflow.total_time_limit = None
    workflow.final_decision_time_limit = None
    workflow = process_message(
        workflow,
        "The Partnership Lead handles intake. Legal, Marketing and Activation sign off.",
    )
    assert workflow.status == "needs_clarification"
    assert workflow.stages == []
    assert workflow.unresolved_questions == ["Approval rule:Legal,Marketing,Activation"]

    workflow = process_message(workflow, "All three must approve.")
    assert workflow.status == "draft"
    assert workflow.unresolved_questions == []
    assert workflow.stages[0].approval_rule.type == "all"
    assert len(workflow.conversation) == 4


def test_conflicting_time_limit_is_retained_until_resolved():
    workflow = load_example("social_digital")
    workflow = process_message(workflow, "Intake is eight hours.")
    assert workflow.intake_time_limit.amount == 4
    assert workflow.unresolved_questions[0].startswith("Time limit conflict|intake|")

    workflow = process_message(workflow, "Use the new value.")
    assert workflow.intake_time_limit.amount == 8
    assert workflow.unresolved_questions == []


def test_llm_parser_applies_complex_rules_and_preserves_server_fields(monkeypatch):
    workflow = load_example("social_digital")
    response_workflow = workflow.model_dump(mode="json", by_alias=True)
    response_workflow["stages"][0]["approvalRule"] = {
        "type": "all",
        "rules": [
            {"type": "role", "role": "Legal"},
            {
                "type": "any",
                "rules": [
                    {"type": "role", "role": "Marketing"},
                    {"type": "role", "role": "Activation"},
                ],
            },
        ],
    }
    response_body = json.dumps({
        "choices": [{
            "message": {
                "content": json.dumps({
                    "workflow": response_workflow,
                    "assistant_message": "Added the combined approval rule.",
                })
            }
        }]
    }).encode()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def read(self):
            return response_body

    def fake_urlopen(request, timeout):
        assert request.full_url == "https://llm.example/v1/chat/completions"
        assert request.get_header("Authorization") == "Bearer test-key"
        assert timeout == 45
        assert json.loads(request.data)["response_format"] == {"type": "json_object"}
        return FakeResponse()

    monkeypatch.setenv("APPROVALLAB_LLM_BASE_URL", "https://llm.example/v1/")
    monkeypatch.setenv("APPROVALLAB_LLM_API_KEY", "test-key")
    monkeypatch.setenv("APPROVALLAB_LLM_MODEL", "test-model")
    monkeypatch.setattr(llm_parser, "urlopen", fake_urlopen)

    updated = process_message(workflow, "Legal must approve, plus either Marketing or Activation.")

    assert isinstance(updated.stages[0].approval_rule, GroupRule)
    assert updated.stages[0].approval_rule.rules[0] == RoleRule(type="role", role="Legal")
    assert updated.stages[0].approval_rule.rules[1].type == "any"
    assert updated.id == workflow.id
    assert updated.version == workflow.version
    assert updated.conversation[-2].content == "Legal must approve, plus either Marketing or Activation."
    assert updated.conversation[-1].content == "Added the combined approval rule."


def test_llm_parser_configuration_errors_are_reported_by_api(client, monkeypatch):
    workflow = client.post("/api/workflows").json()
    monkeypatch.setenv("APPROVALLAB_LLM_BASE_URL", "https://llm.example/v1")
    monkeypatch.delenv("APPROVALLAB_LLM_API_KEY", raising=False)
    monkeypatch.delenv("APPROVALLAB_LLM_MODEL", raising=False)

    response = client.post(
        f"/api/workflows/{workflow['id']}/messages",
        json={"content": "Legal has to approve the proposal."},
    )

    assert response.status_code == 502
    assert "requires APPROVALLAB_LLM_BASE_URL" in response.json()["detail"]


def test_api_requires_confirmation_and_exports_a_confirmed_snapshot(client):
    response = client.post("/api/workflows", json=load_example("social_digital").model_dump(mode="json", by_alias=True))
    assert response.status_code == 200
    workflow = response.json()
    workflow_id = workflow["id"]

    assert client.get(f"/api/workflows/{workflow_id}/export/json").status_code == 409
    assert client.get(f"/api/workflows/{workflow_id}/export/pdf").status_code == 409
    confirmation = client.post(f"/api/workflows/{workflow_id}/confirm")
    assert confirmation.status_code == 200
    assert confirmation.json()["status"] == "confirmed"

    json_response = client.get(f"/api/workflows/{workflow_id}/export/json")
    assert json_response.status_code == 200
    assert json.loads(json_response.content)["version"] == 1
    pdf_response = client.get(f"/api/workflows/{workflow_id}/export/pdf")
    assert pdf_response.status_code == 200
    assert pdf_response.content.startswith(b"%PDF")


def test_editing_confirmed_workflow_invalidates_confirmation(client):
    draft = client.post("/api/workflows", json=load_example("social_digital").model_dump(mode="json", by_alias=True)).json()
    confirmed = client.post(f"/api/workflows/{draft['id']}/confirm").json()
    changed = {**confirmed, "name": "Updated title"}
    response = client.patch(f"/api/workflows/{draft['id']}", json=changed)

    assert response.status_code == 200
    assert response.json()["status"] == "ready_for_review"
    assert response.json()["version"] == confirmed["version"] + 1
    assert "confirmedAt" not in response.json()
