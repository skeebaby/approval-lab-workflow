#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-}"

if [[ -z "$PYTHON" ]]; then
  if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    PYTHON="$ROOT_DIR/.venv/bin/python"
  else
    PYTHON="python3"
  fi
fi

python_available=0
if [[ "$PYTHON" == */* ]]; then
  [[ -x "$PYTHON" ]] && python_available=1
else
  command -v "$PYTHON" >/dev/null 2>&1 && python_available=1
fi

if [[ "$python_available" -ne 1 ]]; then
  echo "Python executable not found: $PYTHON" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to start the frontend." >&2
  exit 1
fi

backend_pid=""
frontend_pid=""

cleanup() {
  [[ -z "$backend_pid" ]] || kill "$backend_pid" 2>/dev/null || true
  [[ -z "$frontend_pid" ]] || kill "$frontend_pid" 2>/dev/null || true
  [[ -z "$backend_pid" ]] || wait "$backend_pid" 2>/dev/null || true
  [[ -z "$frontend_pid" ]] || wait "$frontend_pid" 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$ROOT_DIR/backend"
  exec "$PYTHON" -m uvicorn app.main:app --reload
) &
backend_pid=$!

(
  cd "$ROOT_DIR/frontend"
  exec npm run dev
) &
frontend_pid=$!

echo "Backend:  http://localhost:8000"
echo "Frontend: http://localhost:5173"
echo "Press Ctrl+C to stop both servers."

wait -n "$backend_pid" "$frontend_pid"
