from pydantic import BaseModel, ConfigDict
from typing import Optional, List


# Task schemas
class TaskBase(BaseModel):
    text: str
    start_date: str
    end_date: str
    duration: Optional[int] = None
    progress: Optional[float] = 0.0
    parent: Optional[int] = 0
    kind_task: Optional[int] = 1
    owner_id: Optional[int] = 0
    sortorder: Optional[int] = 0
    color: Optional[str] = None
    textColor: Optional[str] = None
    ToDo: Optional[str] = None
    task_schedule: Optional[str] = None
    folder: Optional[str] = None
    url_adress: Optional[str] = None
    mail: Optional[str] = None
    memo: Optional[str] = None
    hyperlink: Optional[str] = None
    edit_date: Optional[str] = None
    is_pinned: Optional[bool] = False


class TaskCreate(TaskBase):
    id: Optional[int] = None


class TaskUpdate(BaseModel):
    text: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    duration: Optional[int] = None
    progress: Optional[float] = None
    parent: Optional[int] = None
    kind_task: Optional[int] = None
    owner_id: Optional[int] = None
    sortorder: Optional[int] = None
    color: Optional[str] = None
    textColor: Optional[str] = None
    ToDo: Optional[str] = None
    task_schedule: Optional[str] = None
    folder: Optional[str] = None
    url_adress: Optional[str] = None
    mail: Optional[str] = None
    memo: Optional[str] = None
    hyperlink: Optional[str] = None
    edit_date: Optional[str] = None
    is_pinned: Optional[bool] = None


class Task(TaskBase):
    id: int
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


# Link schemas
class LinkBase(BaseModel):
    source: int
    target: int
    type: Optional[int] = 0


class LinkCreate(LinkBase):
    pass


class Link(LinkBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


# Response schemas
class GanttData(BaseModel):
    tasks: List[Task]
    links: List[Link]


class DeleteResponse(BaseModel):
    deleted_id: int
    deleted_children: List[int]


class ImportResponse(BaseModel):
    imported_count: int
    skipped_count: int
    errors: List[str]


class TaskReorderItem(BaseModel):
    id: int
    sortorder: int
    parent: int


class TaskReorderRequest(BaseModel):
    items: List[TaskReorderItem]


class TaskOpenInputRequest(BaseModel):
    request_id: int
    task_id: int
    created_at: str


class TaskOpenInputResponse(BaseModel):
    status: str
    task_id: int
    input_opened: bool
    gantt_visible: bool
    request: TaskOpenInputRequest
    visibility_error: Optional[str] = None


# Grid diff schemas（グリッド差分確認用）
class GridDiffItem(BaseModel):
    """差分1件分のスキーマ"""
    id: int
    table: str  # "tasks" or "links"
    field: str  # 変更されたフィールド名
    original: Optional[str] = None  # 本テーブルの値（文字列化）
    current: Optional[str] = None  # ステージングの値（文字列化）


class GridRevertRequest(BaseModel):
    """ステージングの指定差分を元に戻すためのリクエスト"""
    table: str
    id: int
    field: str


class GridDiffResponse(BaseModel):
    """差分一覧レスポンス"""
    diffs: List[GridDiffItem]


class GridCommitResponse(BaseModel):
    """アップロード結果"""
    updated_tasks: int
    updated_links: int
    errors: List[str]


class CsvDiffExample(BaseModel):
    id: str
    label: str
    changed_fields: List[str] = []


class CsvDiffSection(BaseModel):
    added_count: int
    deleted_count: int
    modified_count: int
    unchanged_count: int
    added_examples: List[CsvDiffExample] = []
    deleted_examples: List[CsvDiffExample] = []
    modified_examples: List[CsvDiffExample] = []


class ObsidianCsvSyncHistoryEntry(BaseModel):
    exists: bool = True
    status: str
    checked_at: str
    saved_at: Optional[str] = None
    output_dir: str
    task_csv_path: str
    link_csv_path: str
    summary_json_path: str
    summary_markdown_path: str
    tasks: CsvDiffSection
    links: CsvDiffSection


class ObsidianCsvSyncSummary(BaseModel):
    exists: bool = True
    status: str
    checked_at: str
    saved_at: Optional[str] = None
    output_dir: str
    task_csv_path: str
    link_csv_path: str
    summary_json_path: str
    summary_markdown_path: str
    tasks: CsvDiffSection
    links: CsvDiffSection
    history: List[ObsidianCsvSyncHistoryEntry] = []


class ObsidianCsvSummaryNotFound(BaseModel):
    exists: bool = False
    output_dir: str
    summary_json_path: str
    summary_markdown_path: str


class ResolvedTaskLink(BaseModel):
    task_id: int
    hyperlink: str
    updated: bool = False


class HolidayListResponse(BaseModel):
    holidays: List[str]
    raw_text: str
    file_path: str


class HolidayCreateRequest(BaseModel):
    date: str


class HolidayRawUpdateRequest(BaseModel):
    raw_text: str


class BusinessTripEntry(BaseModel):
    date: str
    type: str


class BusinessTripListResponse(BaseModel):
    business_trips: List[BusinessTripEntry]
    raw_text: str
    file_path: str


class BusinessTripCreateRequest(BaseModel):
    date: str
    type: str


class BusinessTripRawUpdateRequest(BaseModel):
    raw_text: str


class SynonymGroupsResponse(BaseModel):
    groups: List[List[str]]
