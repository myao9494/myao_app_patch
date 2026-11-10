#!/bin/sh
# Run people_cli.py (Mac / Linux). The Windows version is run.bat. Same arguments.
# It needs only the standard library, so it works without the venv too.
# This file must stay ASCII only, with LF line endings.
here=$(cd "$(dirname "$0")" && pwd -P)  # resolve links: the .venv is next to the real skills folder
PY="$here/../../.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY=python3
  command -v "$PY" >/dev/null 2>&1 || PY=python
fi
exec "$PY" "$here/scripts/people_cli.py" "$@"
