"""API のリクエスト・レスポンスのデータモデル"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ValidationErrorDetail(BaseModel):
    """バリデーションエラーの詳細情報"""
    field: str          # エラーフィールドパス (例: "elements[0].points")
    message: str        # エラーメッセージ
    value: Optional[str] = None  # 問題のある値（文字列化）


class JsonErrorResponse(BaseModel):
    """JSON読み込みエラーのレスポンス"""
    error_type: str     # "json_syntax" | "validation" | "schema"
    message: str        # ユーザー向けメッセージ
    line: Optional[int] = None      # エラー行数
    column: Optional[int] = None    # エラーカラム位置
    context: Optional[str] = None   # エラー周辺のテキスト
    details: Optional[List[ValidationErrorDetail]] = None


class ExcalidrawFileData(BaseModel):
    # 旧版・将来版・社内拡張のトップレベル項目を保存時に落とさない。
    model_config = ConfigDict(extra="allow")

    type: str = "excalidraw"
    version: int = 2
    source: str = "https://excalidraw.com"
    elements: List[Dict[str, Any]] = Field(default_factory=list)
    appState: Dict[str, Any] = Field(default_factory=dict)
    files: Dict[str, Any] = Field(default_factory=dict)


class SaveFileRequest(BaseModel):
    filepath: str
    data: ExcalidrawFileData
    force_backup: bool = False  # デフォルトは自動保存扱い（10分制限あり）


class OpenFileRequest(BaseModel):
    filepath: str


class OpenFileResponse(BaseModel):
    success: bool
    targetType: Optional[str] = None
    resolvedPath: Optional[str] = None
    message: Optional[str] = None


class SaveEmailRequest(BaseModel):
    emailData: str
    subject: str
    currentPath: str


class FileUploadResponse(BaseModel):
    success: bool
    files: List[Dict[str, Any]] = []
    error: Optional[str] = None


class FolderShortcutResponse(BaseModel):
    success: bool
    folderPath: Optional[str] = None
    error: Optional[str] = None


class EmailSaveResponse(BaseModel):
    success: bool
    savedPath: Optional[str] = None
    error: Optional[str] = None


class SaveLibraryRequest(BaseModel):
    file_path: str
    data: Dict[str, Any]


class SaveLibraryResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    error: Optional[str] = None


class SaveSvgRequest(BaseModel):
    filepath: str
    svg_content: str


class OpenFolderRequest(BaseModel):
    path: str


class OpenFolderResponse(BaseModel):
    success: bool
    openedPath: Optional[str] = None
    error: Optional[str] = None


class OpenEditorRequest(BaseModel):
    path: str


class OpenEditorResponse(BaseModel):
    success: bool
    openedPath: Optional[str] = None
    fallbackUsed: bool = False
    message: Optional[str] = None


class RunCommandRequest(BaseModel):
    command: str
    working_directory: Optional[str] = None


class RunCommandResponse(BaseModel):
    success: bool
    command: str
    pid: Optional[int] = None
    error: Optional[str] = None


class ListDirectoryRequest(BaseModel):
    path: Optional[str] = None
    show_hidden: bool = False


class DirectoryEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: Optional[int] = None
    modified: Optional[float] = None


class ListDirectoryResponse(BaseModel):
    success: bool
    path: str
    parentPath: Optional[str] = None
    entries: List[DirectoryEntry] = Field(default_factory=list)
    error: Optional[str] = None


class ArchiveFileRequest(BaseModel):
    filepath: str


class ArchiveFileResponse(BaseModel):
    success: bool
    archivedPath: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None
