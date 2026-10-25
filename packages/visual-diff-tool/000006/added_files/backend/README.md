# Visual Diff Tool Backend

```bash
../.venv/bin/python run.py
```

The server listens on `127.0.0.1:8078` (`PORT` to change) and serves the built web app from `../frontend/dist` at `/`.
Automatic reload is disabled to reduce idle CPU; set `VISUAL_DIFF_RELOAD=1` during backend development.

Environment variables:

- `VISUAL_DIFF_OPEN_BROWSER=0`: do not open the browser after a localhost `/api/diff` call
- `VISUAL_DIFF_SETTINGS_PATH`: alternative server settings file
- `VISUAL_DIFF_GIT_EXE`: git executable to use (Windows: avoids the `cmd\git.exe` launcher)
- `VISUAL_DIFF_3D_RETENTION_MINUTES`: how long 3D job results are kept (default 60)

Module layout, the endpoint list, input limits, and performance design are documented in [../CLAUDE.md](../claude.md). Request/response examples are in the web app at `/api-guide`.
