# Visual Diff Tool

PNG, JPEG, WebP, BMP, GIF, SVG, PDF, TIFF, and Excalidraw files can be compared in a local web UI. The backend converts inputs to images, aligns image B to image A with OpenCV, and returns side-by-side diff data with an overlay, mask, and changed rectangles. STEP CAD models can also be compared in 3D, and changed files in a Git working tree (images, text, and STEP models) can be reviewed against HEAD.

The development specification (Japanese) is in [CLAUDE.md](claude.md); feature-level designs and diagrams are in [docs/](docs/).

The first implementation focuses on the web app and local Backend API. VSCode extension integration is planned but not included yet.

## Current Capabilities

- Upload, drop, or paste two inputs and preview the selected page before comparing. A right-hand inspector shows the diff ratio, a color legend, threshold/category/anchor settings, and a clickable list of changed regions that zooms both panes to each change (`]` / `[` to step, `Esc` to clear).
- Compare PNG, JPEG, WebP, BMP, GIF, SVG, PDF, TIFF, Excalidraw JSON, and Obsidian Excalidraw Markdown. Git treats `*.excalidraw.md` and `*_excalidraw.md` as images and decodes Obsidian's `compressed-json` drawing block.
- Select pages independently for multi-page PDF/TIFF inputs.
- Browse changed files in a Git working tree from a sidebar (kind icons, change badges, filter, per-file HTML export checkboxes) and compare changed image and text files, including additions, deletions, untracked files, and staged renames where the HEAD-side path differs. Markdown notes with `excalidraw-plugin: parsed` expose both a text diff and a separate embedded Excalidraw image diff; Git arrow-key navigation cycles through both targets.
- Show text changes in a VS Code-style side-by-side view with line numbers, strongly colored added/deleted rows, visible empty-side gaps, and inline character highlighting. Text extensions are configurable from the hamburger menu and saved locally in the browser.
- Add image annotations or per-file text memos from the Git tab, choose whether each changed file is included, then export the selected changes as one static, self-contained HTML report. Images, annotations, CSS, and the small content-zoom script are embedded; the report does not load external scripts, fonts, or any other network resources.
- Align image B to image A with staged OpenCV feature matching and ECC refinement.
- Switch between aligned B, diff overlay, and mask views.
- Adjust the diff threshold after comparison without rerunning alignment.
- Preserve thin drawing-line changes in the diff mask while filtering isolated single-pixel noise.
- Open a separate diff memo tab after comparison. It provides an A/B slider, draggable color-coded memos and leader lines, adjustable arrows, change clouds, rectangles, ellipses, thin markers, and independent yellow sticky notes. Memos enter text editing only on double-click; selected drawings have a visible selection frame and support Delete, undo, and redo. The memo list is resizable/collapsible and navigates to a selected memo. Annotated A, B, or side-by-side images can be copied from the right-click menu.
- Excalidraw conversion is a lightweight built-in renderer. It handles basic shapes and text, and returns warnings for approximated or unsupported features such as embedded images, rotation, arrow heads, text styling, and opacity.
- Draw.io SVG conversion replaces its browser-only `foreignObject` labels with portable SVG text, preserving full label text and explicit line breaks before rasterization.
- Compare two STEP (`.step` / `.stp`) models in the 3D tab: automatic alignment, overlay or synchronized side-by-side view, a real-time tolerance slider, smart dimensions (φ / R / linear / chamfer), 3D annotations, and hatched section views. Heavy CAD processing runs in a child process. Changed STEP files in the Git tab (including STEP files referenced from Markdown code blocks) open in the same viewer; added or deleted models are shown as single-model previews. Six sample pairs can be loaded from the UI.

## Run

Install Python 3.12 or a compatible Python 3 version first.

### macOS

```bash
./start_mac.sh
```

### Windows

```bat
start_windows.bat
```

Both scripts create `.venv` if needed, run `pip install -r requirements.txt`, and start the FastAPI server.
On Windows, if an existing broken `.venv` cannot be removed because of file locks or ownership, `start_windows.bat` falls back to `.venv_windows`.
Automatic backend reload is disabled for normal use to reduce idle CPU. Developers can set `VISUAL_DIFF_RELOAD=1` when they need file-watcher reloads.
After startup, open:

```text
http://127.0.0.1:8078/
```

## API

Request/response examples for external apps are available in the app at `/api-guide` (and FastAPI's `/docs`). Detailed behavior is documented in [CLAUDE.md](claude.md).

- File diff: `GET /api/health`, `POST /api/attachments`, `POST /api/analyze`, `POST /api/convert`, `POST /api/diff`, `POST /api/rediff`, `GET /api/diff/{result_id}`
- Git diff: `POST /api/git/images`, `POST /api/git/files`, `POST /api/git/markdown` / `GET /api/git/markdown?path=...`, `POST /api/git/item`, `POST /api/git/text-diff`, `POST /api/git/save-text`, `POST /api/git/revert-line`, `POST /api/git/diff`
- 3D diff: `GET /api/3d/status`, `GET /api/3d/samples`, `POST /api/3d/samples/load`, `POST /api/3d/jobs`, `GET /api/3d/jobs/{job_id}`, `GET /api/3d/jobs/{job_id}/mesh/{side}`, `DELETE /api/3d/jobs/{job_id}`, `POST /api/git/3d/jobs`
- Settings and reports: `GET /api/settings/obsidian`, `PUT /api/settings/obsidian`, `POST /api/reports/save`

`/api/diff` normally returns a bounded in-memory `result_id` in addition to the encoded result images. The UI uses that ID with `/api/rediff` when only the diff threshold changes, so threshold tuning reuses the aligned images instead of converting and aligning the files again. Extremely large pairs that cannot fit in the cache return `null` for this optional field.

The Obsidian folder and report folder are stored in `backend/.visual-diff-settings.json`. This file is intentionally tracked by Git with empty defaults (a company-side integrity check rejects git-ignored settings files); do not commit your local values.

## Project Layout

- `backend/app/main.py`: FastAPI app, router registration, and static serving of `frontend/dist`
- `backend/app/routes/`: endpoints (`images`, `git`, `three_d`, `settings`)
- `backend/app/`: image pipeline (`diff_pipeline`, `alignment`, `diffing`, `image_io`, caches), Git and Obsidian support (`git_repo`, `markdown_links`, `text_diff`), 3D (`mesh_jobs`, `step_mesh`, `mesh_diff`)
- `frontend/src/`: `app/` (main screen), `memo/` (diff memo tab), `report/` (HTML report preview and generation), `git/`, `components/`, `lib/`, `three-diff/`
- `tests/` (backend, unittest) and `frontend/test/` (frontend, `node --test`)

## Performance Notes

- Upload rasterization is cached by file content, extension, DPI, and selected page. This avoids repeating the same conversion across previews and comparisons while keeping multi-page documents from being fully rasterized for every selected page.
- Diff result images are cached behind `result_id` for quick threshold recalculation.
- Both caches have item and memory limits, so large documents may be evicted and recalculated when needed.
- Uploaded files are limited to 100 MB each. PDF/TIFF inputs are limited to 60 pages, 90 megapixels per rasterized page, and 180 megapixels when a full-document rasterization path is used.
- Git text files are limited to 5 MB and 30,000 lines per side. Very long changed lines are highlighted as a whole to keep diff generation responsive.
- Git text responses omit unused full-file copies in the web UI, and HTML export reuses the currently loaded comparison instead of calculating it twice.
- Feature matching stops early when a detector produces a high-confidence transform; harder cases still fall through to the remaining detectors.
- Feature detection is downscaled for very large images and the estimated transform is mapped back to full-resolution coordinates before warping.
- Rasterizing images A/B and PNG-encoding the response images run in parallel threads; image-processing endpoints run in FastAPI's thread pool so long comparisons do not block other requests.
- The pixel diff (YIQ distance, noise filtering, overlay compositing) runs as vectorized OpenCV operations, about 2.4x faster at 12 MP with byte-identical results, so threshold tuning responds faster. PDF pages are size-checked before rendering.
- Selecting a file rasterizes it once: `/api/analyze`, `/api/convert`, and `/api/diff` share the raster cache.
- Anchor-region detection and in-line text highlighting have bounded cost, so grid charts and very long repetitive lines no longer stall requests.
- The diff memo tab keeps the compared images, memos, drawings, sticky notes, and layout geometry in IndexedDB, with a localStorage fallback for older browsers. Stored geometry uses layout dimensions so app-level display scaling does not shift exported annotations. These are UI annotations only and are not part of the image-diff calculation or Backend API data model.

## Frontend Distribution

`frontend/dist` is intentionally committed so Windows offline users do not need Node.js or `npm install`.
When changing the frontend, use Node.js 20.19+ or 22.12+ and rebuild it before committing. The build uses esbuild's classic JSX transform (there is no `vite.config`), so every `.jsx` file must `import React`. The repository includes `frontend/.nvmrc` for the validated Node.js 22.22.2 environment:

```bash
cd frontend
npm install
npm run build
```

The FastAPI backend serves the built frontend from `frontend/dist`, so deployment only needs Python dependencies plus the committed repository contents.

## Verification

```bash
.venv/bin/python -m unittest discover -s tests
```

```bash
cd frontend && npm test
```

To generate a contact sheet that checks all sample alignments:

```bash
.venv/bin/python scripts/verify_samples.py
```
