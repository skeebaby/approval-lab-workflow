# ApprovalLab Property Workflow Builder

A local workflow-builder MVP with a React/TypeScript frontend and a FastAPI backend. The backend owns workflow validation, clarification/extraction, SQLite persistence, confirmation, and JSON/PDF exports. The frontend edits and displays the API's canonical workflow.

## Requirements

- Python 3.11+
- Node.js 20+
- npm

## Run locally

Install the backend and frontend dependencies, then start both servers from the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e "backend[test]"
npm --prefix frontend install
./scripts/start.sh
```

The script starts the API at `http://localhost:8000` and the frontend at `http://localhost:5173`. Press Ctrl+C to stop both servers. SQLite data is stored in `backend/approval_lab.db`; set `APPROVALLAB_DATABASE` to use a different path.

To run either service separately:

```bash
# Backend, from the repository root after activating .venv
cd backend && uvicorn app.main:app --reload

# Frontend, from the repository root
cd frontend && npm run dev
```

Set `VITE_API_BASE_URL` if the backend is not at `http://localhost:8000/api`.

## Repository layout

```text
backend/
  app/
    api/          FastAPI routes
    domain/       Workflow validation, rules, merge, and registry
    extraction/   Deterministic extraction adapter
    exporters/    Confirmed JSON and PDF exporters
    models/       Pydantic workflow models
    persistence/  SQLite repository
  tests/
examples/
  experience_promos/workflow.json
  social_digital/workflow.json
frontend/
  src/
    api/          Backend client
    components/   Workflow builder UI
    App.tsx
schemas/
docs/
```

## Workflow and exports

Drafts and conversation messages are persisted in SQLite and listed in the left panel, where workflows can be reopened across draft, ready-for-review, and confirmed states. Explicit confirmation records a timestamp on a workflow version; confirmed workflows remain editable, and edits invalidate the confirmation and increment the revision. JSON and PDF endpoints only export the confirmed, validated version. The JSON shape is described by [`schemas/workflow.schema.json`](./schemas/workflow.schema.json).

Extraction is deterministic and local to the backend; it is not a provider-backed LLM. Unknown asset types, roles, and conditions are preserved as custom values and can be edited in the workflow review UI. Clarifications are required for ambiguous approval rules and conflicting time limits. Unsupported phrasing should be corrected in the editor before confirmation.

## Tests

```bash
# Frontend, from frontend/
npm test
npm run build

# Backend, from repository root
python -m pytest backend/tests
```

All tests run offline and require no model key. The challenge examples are fixtures with documented defaults; no extraction-accuracy claims are made.

## Scope

This MVP does not include login, sponsor-side routing, submissions or approval simulation, reminders, escalations, or live ApprovalLab integration.

See [`docs/design-note.md`](./docs/design-note.md) for defaults, limitations, and a 30-minute walkthrough.
