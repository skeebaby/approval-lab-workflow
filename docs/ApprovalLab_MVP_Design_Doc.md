# ApprovalLab Property Workflow Builder — MVP Design Document

**Purpose:** Implementation guide for the ApprovalLab Property Workflow Builder challenge  
**Scope:** Focused, locally runnable MVP  
**Source of requirements:** *ApprovalLab Property Workflow Builder — Challenge Project* (uploaded challenge brief)

---

## 1. Product Goal

Build a browser-based tool that lets a Property lead describe, in natural language, how sponsorship creative gets approved. The tool converts the description into:

1. A workflow diagram exported as PDF for the Property to review and sign off on.
2. A structured JSON configuration that an engineer could load into ApprovalLab.

The user must be able to describe the process in one message or across multiple messages, review and correct the complete workflow, and confirm it before export.

### Explicitly out of scope

Do not build these for the MVP:

- Sponsor-side routing
- Different workflows by Sponsor
- Actual submission execution or simulation
- Changing routing while a submission is under review
- Reminders, escalations, or notifications
- Versioning of the predetermined value lists
- Learning from previous sessions
- Login/authentication
- Integration with ApprovalLab

Use synthetic data only.

## 2. MVP Architecture

Use a single backend application and a browser frontend. Avoid microservices.

```text
Browser UI (React + TypeScript)
  ├── Conversation / clarification UI
  ├── Workflow summary and editable stages
  └── Diagram preview and export controls
             |
             v
FastAPI application
  ├── Conversation API
  ├── LLM extraction adapter
  ├── Draft merge service
  ├── Workflow validation engine
  ├── Clarification engine
  ├── Confirmation service
  └── JSON / PDF exporters
             |
             v
Persistence (SQLite)
  ├── workflows
  └── conversations (optional for smallest MVP)
```

### Recommended stack

| Layer | Choice | Purpose |
|---|---|---|
| Frontend | React, TypeScript, Vite | Browser UI |
| Backend | Python, FastAPI | API and orchestration |
| Data models | Pydantic | Input/output validation |
| Persistence | SQLite | Save drafts and confirmed workflows |
| AI | LLM with structured output, behind an adapter | Natural-language extraction |
| PDF | ReportLab or browser print-to-PDF | PDF workflow diagram |
| Diagram | Mermaid or React Flow | Diagram preview |
| Tests | pytest; frontend tests as needed | Repeatable validation |

Keep AI provider-specific code behind an interface so offline tests and a different model provider can be used without changing domain logic.

## 3. Core Design Principle

**The LLM proposes structured facts; deterministic application code owns workflow semantics and correctness.**

The LLM must not independently generate the authoritative final PDF or JSON. It extracts a candidate workflow representation. Application code then merges facts, validates semantics, decides whether clarification is required, and produces exports from the same confirmed workflow object.

This separation makes the application easier to test, debug, and explain.

## 4. Workflow Data Model

Create one canonical `WorkflowDraft` model. The frontend, validator, JSON exporter, and PDF exporter must use this model as their source of truth.

### Workflow-level fields

- `id`
- `asset_type`
- `owner_role`
- `stages` — ordered list
- `conditions` — conditional routing rules
- `time_limits` — intake, each stage, final decision, and overall workflow
- `in_the_know` — viewers who do not block progress
- `status` — for example `draft`, `needs_clarification`, `ready_for_review`, `confirmed`
- `version`
- `assumptions` — defaults applied by the system
- `unresolved_questions`
- `created_at`, `updated_at`

### Stage fields

- `id`
- `position`
- `name`
- `time_limit`
- `participants`
- `approval_rule`
- `applies_when` — optional condition references

### Participant fields

- `role` — a predefined role or preserved custom value
- `organization_type` — Property or outside organization, where applicable
- `participation` — `approver`, `consultative`, or `viewer`
- Optional notes or source evidence

A viewer may be in the know without belonging to a review stage. Consultative participants give input but do not hold up the workflow. Only approvers contribute to approval rules.

### Approval rules

Represent approval rules as a recursive expression tree, not a single `ALL`/`ANY` enum. The challenge allows compound rules such as “Legal, plus either Marketing or Activation.”

Example:

```json
{
  "type": "all",
  "rules": [
    {"type": "role", "role": "Legal"},
    {
      "type": "any",
      "rules": [
        {"type": "role", "role": "Marketing"},
        {"type": "role", "role": "Activation"}
      ]
    }
  ]
}
```

Support at least:

- `all`: all child rules must be satisfied
- `any`: at least one child rule must be satisfied
- `n_of_m`: at least N eligible approvers must approve
- `role`: a specific role's approval is required

### Conditions

Represent each condition separately from its effect. Support:

- Predefined conditions from the challenge
- Custom conditions that must not be silently mapped to an incorrect predefined condition
- Adding a participant to a stage
- Changing an existing participant's participation type

Predefined conditions:

- Uses a player's likeness
- Uses league marks
- Involves the venue or game day
- Includes legal, contest or sweepstakes language
- Will run on social media
- Will run in paid or broadcast media
- Is sensitive to ownership
- Is sensitive for executives

### Time limits

Represent units explicitly and consistently. The challenge defines one business day as eight hours. Support limits for:

- Intake
- Each stage
- Final decision
- Entire workflow

Do not treat the total workflow deadline as interchangeable with the sum of stage limits. If the relationship is unclear, record the assumption or ask a clarification question when it materially affects interpretation.

### Predetermined values

Keep the fixed lists in a central registry/configuration module.

**Asset types**
- Legacy Advertising
- Signage & Venue
- Team & Uniform
- Social & Digital
- Athlete & Talent
- Experience & Promos
- Merch & Retail

**Roles inside the Property**
- Partnership Lead
- Legal
- Outside Counsel
- Marketing
- Activation
- Sales
- Executive Leadership
- Ownership
- Game-Day Operations
- Venue Operations
- Player Personnel
- Talent Relations
- Communications/PR
- Social/Digital
- Partnership Services

**Outside organizations**
- League Office
- Player Agent
- Venue Owner
- Rights Holder

Unknown role or condition values must be retained as custom values rather than forced into the nearest predefined value. Map user-specific role names to a predefined role only when the mapping is sufficiently clear; otherwise ask or preserve the custom value.

## 5. Conversation and Extraction Flow

Implement a controlled workflow, not a general autonomous agent.

1. Receive a user message.
2. Send the message and relevant current draft to the extraction adapter.
3. Extract structured candidate facts, including explicit facts, inferred defaults, and ambiguities.
4. Merge the new facts into the existing draft without discarding unrelated facts.
5. Run schema and semantic validation.
6. Determine whether required information is missing or materially ambiguous.
7. If clarification is needed, ask a focused question and preserve the draft.
8. Otherwise, display the complete workflow for user review.
9. Apply user corrections to the same canonical model.
10. Confirm the workflow only after the user explicitly approves it.
11. Generate JSON and PDF from the same confirmed snapshot.

### Extraction output

The LLM should return structured data, not prose-only descriptions. Include:

- Candidate asset type and owner
- Ordered stages
- Participants and participation types
- Approval-rule expression
- Conditions and actions
- Time limits and their scope
- Explicit facts and inferred assumptions
- Unresolved ambiguities
- Evidence/source message for important extracted facts, if practical

Use Pydantic validation after parsing the model output. Invalid model output must produce a recoverable error or a retry; it must not bypass validation.

### Merge and conflict policy

- Merge facts across messages, since descriptions may arrive in any order.
- Preserve existing facts when a message adds unrelated information.
- If a new statement conflicts with an earlier statement, mark the conflict and ask the user rather than silently selecting one.
- A correction from the user should update the relevant field and retain the rest of the workflow.
- Track assumptions separately from explicitly stated facts.

### Clarification policy

Ask questions only when missing or ambiguous information materially changes the workflow or a required field cannot be determined.

Examples:
- Does “Legal, Marketing and Activation sign off” mean all must approve, or any one?
- Does the Social team approve in addition to the other approvers, or count as an alternative?
- Does an outside approval apply to every submission or only when a condition is met?

Use facts supplied by the challenge where applicable. If a sensible default is selected, record and disclose it. Avoid asking the user to repeat facts already provided.

## 6. Validation and Confirmation

Keep domain validation in ordinary Python functions independent of the LLM and HTTP framework.

Validate at least:

- Asset type is supported or explicitly preserved as custom if the product policy allows it
- Stage positions are unique and ordered
- Each stage has a valid time limit or a recorded unresolved issue
- Participant roles and participation types are valid
- Approval rules reference eligible approvers
- Compound rules are structurally valid
- Conditions use known or explicitly custom values
- Condition actions reference valid stages and participants
- Intake, stage, final-decision and total time limits are represented separately
- No unresolved material ambiguity remains at confirmation

Use clear validation errors that can be shown to the user.

### Status lifecycle

Suggested states:

- `draft`: collecting information
- `needs_clarification`: a material question remains
- `ready_for_review`: the model is valid enough to display for review
- `confirmed`: the user approved this exact version

A workflow must not be exported as final before confirmation. Any edit after confirmation must return it to a review-required state or create a new draft version. Exported files must correspond to the confirmed version.

## 7. Persistence

Use SQLite for the MVP. Do not normalize every workflow component into its own table; store the canonical workflow as JSON.

### Minimal `workflows` table

- `id` — primary key
- `asset_type`
- `workflow_json` — canonical serialized `WorkflowDraft`
- `status`
- `version`
- `created_at`
- `updated_at`
- `confirmed_at` — nullable

### Optional `conversations` table

- `id` — primary key
- `workflow_id` — foreign key
- `messages_json`
- `created_at`
- `updated_at`

For the smallest implementation, conversation messages may live in the workflow record. An `exports` table is optional; exports can be generated on demand from the confirmed snapshot.

Do not add users, organizations, submissions, approval-task tables, Redis, or a separate database server for this challenge.

## 8. API Endpoints

A small API is sufficient:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/workflows` | Create a workflow draft |
| `POST` | `/api/workflows/{id}/messages` | Process a message and update the draft |
| `GET` | `/api/workflows/{id}` | Retrieve draft, status, and unresolved questions |
| `PATCH` | `/api/workflows/{id}` | Apply structured user edits |
| `POST` | `/api/workflows/{id}/confirm` | Validate and confirm the workflow |
| `GET` | `/api/workflows/{id}/export/json` | Export confirmed JSON |
| `GET` | `/api/workflows/{id}/export/pdf` | Export confirmed PDF |

Keep these as routes in one FastAPI application. The domain engine should be callable directly from unit tests without starting the server.

## 9. Frontend MVP

The UI needs four main areas:

1. **Conversation panel:** multi-message natural-language input and assistant clarification questions.
2. **Workflow summary:** asset type, owner, time limits, assumptions, and unresolved questions.
3. **Workflow editor/diagram:** ordered stages, participants, participation types, approval rules, and conditions; allow the user to correct them.
4. **Confirmation/export controls:** explicit confirmation, then PDF and JSON downloads.

A read-only diagram plus editable forms is an acceptable first version and is faster than building a sophisticated drag-and-drop editor. The complete workflow must be reviewable before export.

## 10. PDF and JSON Exports

Both exports must derive from the same confirmed `WorkflowDraft` snapshot.

### JSON

- Validate against a published JSON Schema.
- Include every field required by the challenge.
- Use explicit units for all time limits.
- Represent compound approval rules and conditional actions structurally.
- Preserve custom values.
- Include a schema version for future compatibility if useful.

### PDF

The diagram must show:

- Stages in order
- Approvers and whether all, any, or N-of-M must approve
- Consultative participants
- Viewers / people in the know
- Conditions and their routing effects
- Time limits, including intake, stages, final decision, and total workflow

Include the asset type, workflow owner, and confirmation/revision information. Make the PDF legible and suitable for Property review and sign-off.

## 11. Testing Strategy

All tests must run with one command and without network access or API keys.

### Unit tests

Test:
- `all`, `any`, `n_of_m`, and compound approval rules
- Condition application: add participant and change participation
- Stage ordering and required fields
- Role mapping and custom values
- Time-limit parsing and scope
- Draft merging and conflicting facts
- Clarification decisions
- Confirmation invalidation after edits

### Recorded extraction tests

Save representative LLM outputs as fixtures and replay them offline. Compare generated workflows with manually authored expected workflows. Include simple and complex examples, multi-message descriptions, incomplete inputs, and ambiguous approval rules.

### Required challenge runs

**Experience & Promos**
- Partnership Lead handles intake and final decision
- Intake: one business day
- Activation and Game-Day Operations must both approve
- Venue Operations is consultative
- Legal review: two business days
- Outside Counsel advises when contest/sweepstakes language applies
- If a player is involved, Player Personnel approves alongside Legal; Player Agent approves afterward
- If it happens in the arena, Venue Owner approves
- If it uses league marks, League Office approves
- Outside approvals happen in parallel and have four business days
- Marketing and Sales are viewers
- Total workflow limit: twelve business days

**Social & Digital**
- Partnership Lead handles intake and final decision
- Intake: four hours
- Social/Digital or Marketing may approve; either one is sufficient
- Partnership Services is a viewer
- Total workflow limit: three business days

For both, the final decision takes four hours. If a required fact is absent from the description and challenge facts, ask a necessary question or apply a sensible disclosed default.

### Accuracy reporting

Report per-field or per-category accuracy for:
- Stage order and membership
- Participant role and participation
- Approval rules
- Conditions and effects
- Time limits and scope
- Clarification quality
- PDF/JSON consistency

Do not claim accuracy results until the tests have actually been run. Include test counts, denominators, and known limitations.

## 12. Suggested Repository Layout

```text
approval-lab/
├── frontend/
│   └── src/
│       ├── components/
│       ├── api/
│       └── App.tsx
├── backend/
│   ├── app/
│   │   ├── api/
│   │   ├── models/
│   │   ├── extraction/
│   │   ├── domain/
│   │   │   ├── merge.py
│   │   │   ├── validation.py
│   │   │   ├── approval_rules.py
│   │   │   ├── conditions.py
│   │   │   └── clarification.py
│   │   ├── persistence/
│   │   ├── exporters/
│   │   │   ├── json_export.py
│   │   │   └── pdf_export.py
│   │   └── main.py
│   └── tests/
├── schemas/
│   └── workflow.schema.json
├── examples/
│   ├── experience_promos/
│   └── social_digital/
├── docs/
│   └── design-note.md
├── .env.example
├── README.md
└── docker-compose.yml  # optional
```

## 13. Implementation Order

Prioritize a working vertical slice before polishing the UI.

1. **Domain model and schema:** define Pydantic models, fixed-value registries, rule expressions, conditions, and time units.
2. **Deterministic engine:** implement merge, semantic validation, approval rules, condition handling, and clarification detection.
3. **Offline tests:** create fixtures and tests before connecting a live model.
4. **LLM extraction adapter:** add structured extraction and error handling.
5. **FastAPI endpoints and SQLite:** persist drafts and conversation state.
6. **Frontend:** build conversation, clarification, workflow review, and editing.
7. **Exports:** generate JSON and PDF from the same confirmed snapshot.
8. **Required runs and evaluation:** complete both Harborview Hawks workflows, report accuracy, and fix issues.
9. **Packaging:** finish README, design note, and 30-minute walkthrough.

## 14. Definition of Done

The MVP is ready when:

- [ ] It starts locally from the README in a current desktop browser.
- [ ] A user can describe a workflow in one or several messages.
- [ ] The app merges new facts without losing earlier facts.
- [ ] It asks targeted questions for material ambiguity.
- [ ] It preserves custom roles and conditions.
- [ ] It represents parallel/sequential stages, all/any/N-of-M rules, consultative participants, viewers, conditions, and time limits.
- [ ] The user can review and correct the complete workflow.
- [ ] Export requires explicit confirmation.
- [ ] PDF and JSON represent the same confirmed workflow.
- [ ] Both required challenge runs have PDF, JSON, and conversation transcript artifacts.
- [ ] Tests run with one command without a network or API key.
- [ ] Test descriptions, accuracy results, limitations, and next steps are documented.
- [ ] A design note of no more than two pages and a 30-minute walkthrough are prepared.

## 15. Decisions to Document

The challenge leaves some operational behavior to the implementer. Record your chosen policy and test it, especially:

- What happens when one member of an `any` approval group requests changes while another approves?
- How should time limits be interpreted when individual stage budgets and the overall deadline differ?
- Which missing fields require clarification versus a disclosed default?
- How are conflicting statements across messages resolved?
- What happens to confirmation when the user edits a workflow?
- How are custom roles and conditions represented in the exported JSON?

Keep these decisions deterministic and visible to the user wherever they affect the workflow.

---

**Implementation principle:** Build the canonical workflow model and deterministic validator first. Then add natural-language extraction, conversation handling, the review UI, and exports. This minimizes the risk of building a polished interface around a data model that cannot express the challenge requirements.
