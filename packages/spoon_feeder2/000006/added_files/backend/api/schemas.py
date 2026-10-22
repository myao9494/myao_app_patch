"""APIリクエストのPydanticモデル定義 (schemas.py)"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..output_limits import DEFAULT_PDF_MAX_MB, MAX_PDF_MAX_MB, MIN_PDF_MAX_MB
from ..security import DEFAULT_GIT_DIFF_COMMAND

DEFAULT_MKDOCS_EXPORT_FOLDER = "~/Desktop/AI_Inputs"


class RepositoryRequest(BaseModel):
    library_path: str
    show_ignored: bool = False


class ContextRequest(BaseModel):
    library_path: str
    selected_files: Optional[list[str]] = None
    reference_files: list[dict] = Field(default_factory=list)


class ReferenceRequest(BaseModel):
    library_path: str
    selected_files: list[str] = Field(default_factory=list)
    python_mode: str = "normal"


class ReferenceMappingRequest(BaseModel):
    library_path: str
    module: str
    repository_path: str


class SettingsRequest(BaseModel):
    library_path: str
    selected_files: list[str] = Field(default_factory=list)
    show_ignored: bool = False


class IgnorePatternsRequest(BaseModel):
    library_path: str
    patterns: list[str] = Field(default_factory=list)


class IgnorePatternRemoveRequest(BaseModel):
    library_path: str
    path: str


class FileRequest(BaseModel):
    library_path: str
    file_path: str


class PatchRequest(BaseModel):
    library_path: str
    ai_output: str
    target_path: str = ""
    overrides: dict[str, str] = Field(default_factory=dict)


class RunTestRequest(BaseModel):
    library_path: str
    test_command: str = "python -m pytest"
    python_mode: str = "normal"
    embedded_python_dir: str = ""
    timeout_sec: int = Field(default=300, ge=1, le=3600)


class FeedbackRequest(BaseModel):
    library_path: str
    test_command: str
    output: str
    exit_code: Optional[int] = None


class OpenRequest(BaseModel):
    library_path: str


class SaveContextRequest(BaseModel):
    library_path: str
    context: str
    target_dir: str = ""
    file_base_name: str = ""


class GitDiffRequest(BaseModel):
    library_path: str
    command: str = DEFAULT_GIT_DIFF_COMMAND


class AutoSelectRequest(BaseModel):
    library_path: str
    selected_files: list[str] = Field(default_factory=list)


class MkDocsExportConfigRequest(BaseModel):
    export_folder: str = DEFAULT_MKDOCS_EXPORT_FOLDER


class MkDocsBundleRequest(BaseModel):
    library_path: str
    selected_files: Optional[list[str]] = None
    target_dir: str = ""
    file_base_name: str = ""
    title: str = ""
    pdf_max_mb: float = Field(default=DEFAULT_PDF_MAX_MB, ge=MIN_PDF_MAX_MB, le=MAX_PDF_MAX_MB)
