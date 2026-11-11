#!/bin/sh
# Run scripts/main.py (Mac / Linux). The Windows version is run.bat. Same arguments.
# This file must stay ASCII only, with LF line endings.
here=$(cd "$(dirname "$0")" && pwd -P)
PY="$here/../../../.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY=python3
  command -v "$PY" >/dev/null 2>&1 || PY=python
fi
exec "$PY" "$here/scripts/main.py" "$@"
