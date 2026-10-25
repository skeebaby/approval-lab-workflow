import json
import os
import sqlite3
from pathlib import Path

from app.models.workflow import Workflow


DATABASE_PATH = Path(
    os.environ.get("APPROVALLAB_DATABASE", Path(__file__).resolve().parents[2] / "approval_lab.db")
)


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                asset_type TEXT NOT NULL,
                workflow_json TEXT NOT NULL,
                status TEXT NOT NULL,
                version INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                confirmed_at TEXT
            )
            """
        )


def save(workflow: Workflow) -> None:
    payload = workflow.model_dump_json(by_alias=True)
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO workflows
              (id, asset_type, workflow_json, status, version, created_at, updated_at, confirmed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              asset_type=excluded.asset_type,
              workflow_json=excluded.workflow_json,
              status=excluded.status,
              version=excluded.version,
              updated_at=excluded.updated_at,
              confirmed_at=excluded.confirmed_at
            """,
            (
                workflow.id,
                workflow.asset_type,
                payload,
                workflow.status,
                workflow.version,
                workflow.created_at.isoformat(),
                workflow.updated_at.isoformat(),
                workflow.confirmed_at.isoformat() if workflow.confirmed_at else None,
            ),
        )


def get(workflow_id: str) -> Workflow | None:
    with connect() as connection:
        row = connection.execute(
            "SELECT workflow_json FROM workflows WHERE id = ?", (workflow_id,)
        ).fetchone()
    if row is None:
        return None
    return Workflow.model_validate_json(row["workflow_json"])


def list_all() -> list[Workflow]:
    with connect() as connection:
        rows = connection.execute(
            "SELECT workflow_json FROM workflows ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
    return [Workflow.model_validate_json(row["workflow_json"]) for row in rows]
