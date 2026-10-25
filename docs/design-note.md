# ApprovalLab MVP design note

## Architecture

The repository follows the frontend/backend layout in the design document. React and TypeScript live in `frontend/`; the single FastAPI app, Pydantic models, domain services, SQLite persistence, and JSON/PDF exporters live in `backend/app/`. The browser calls the backend for draft creation, message processing, editing, confirmation, and exports. Workflow JSON fixtures are stored in `examples/`, with the published JSON Schema in `schemas/`.

The backend's `Workflow` Pydantic model is authoritative. It accepts custom asset categories, roles, and conditions without silently mapping them to a fixed value. Approval rules are recursive expressions of all, any, role, and N-of-M nodes. Conditions target stage ids and describe either adding a participant or changing an existing participant's participation. Intake, stage, final-decision, and total time limits are separate values with explicit units.

## Persistence and confirmation

SQLite stores one canonical workflow JSON document per row, together with status, revision, and timestamps. The browser keeps only the current workflow id in `localStorage`. Confirmation is allowed only when domain validation passes and no clarification remains. Editing a confirmed workflow increments its revision and clears its confirmation. Both export routes independently enforce the confirmed-and-valid rule and use the same Pydantic snapshot.

## Extraction and clarification policy

Extraction is deterministic, runs behind the backend adapter, and requires no API key. It recognizes common phrases for registered asset categories, roles, time limits, approval requirements, and a limited set of conditional reviewers. It merges clear facts from later messages without discarding unrelated fields. Ambiguous approval rules and conflicting time limits are kept as clarification questions. Users may choose the previous or new rule/limit in a follow-up, or edit the structured workflow directly.

This adapter is not a general-purpose language model. Unsupported phrasing may not be recognized and must be checked by the user. No field-accuracy claims are made. A live structured-output LLM adapter and recorded extraction fixtures remain future work.

## Challenge defaults

- A business day is stored as a unit, not automatically converted to eight hours. Stage budgets and the total deadline remain separate.
- The Experience & Promos example treats Activation then Legal as sequential and triggered outside approvals as one parallel external stage with a four-business-day limit.
- Player Personnel is consultative by default and becomes an approver when player likeness applies. Outside Counsel is added as consultative when contest/sweepstakes language applies.
- The Social & Digital example uses a disclosed one-business-day review-stage default; intake and final decision are each four hours and the total limit is three business days.
- Approval behavior after an `any` group member requests changes is not simulated because submission execution is out of scope.

## Walkthrough (30 minutes)

1. Load each challenge example and review conditional routing and disclosed assumptions.
2. Send multiple messages with asset/time facts; verify that the backend merges them.
3. Submit ambiguous approvers and conflicting time limits; resolve the clarification questions.
4. Edit a custom role, rule, participant type, and condition; inspect stage order and validation.
5. Confirm a valid version; download JSON and PDF; edit again and verify both exports require reconfirmation.
