"""
タスク管理システム

非同期で実行されるファイル操作タスクの状態を管理する。
進捗追跡、キャンセル機能を提供する。
"""
import uuid
import threading
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, Literal
from datetime import datetime

TaskStatus = Literal["pending", "running", "completed", "cancelled", "error"]

@dataclass
class TaskInfo:
    """タスク情報を保持するデータクラス"""
    id: str
    status: TaskStatus = "pending"
    progress: int = 0  # 0-100
    current_file: str = ""
    total_files: int = 0
    processed_files: int = 0
    cancelled: bool = False  # キャンセルフラグ
    error_message: Optional[str] = None
    result: Optional[Any] = None
    created_at: datetime = field(default_factory=datetime.now)
    completed_at: Optional[datetime] = None

    def to_dict(self) -> Dict[str, Any]:
        """辞書形式に変換"""
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "current_file": self.current_file,
            "total_files": self.total_files,
            "processed_files": self.processed_files,
            "cancelled": self.cancelled,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class TaskManager:
    """
    タスク管理シングルトンクラス
    
    タスクの作成、状態更新、キャンセルを管理する。
    スレッドセーフな実装。
    """
    _instance: Optional['TaskManager'] = None
    _lock = threading.Lock()

    def __new__(cls) -> 'TaskManager':
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._tasks: Dict[str, TaskInfo] = {}
        self._tasks_lock = threading.Lock()
        self._initialized = True

    def create_task(self, total_files: int = 0) -> TaskInfo:
        """
        新しいタスクを作成する
        
        Args:
            total_files: 処理対象の総ファイル数
            
        Returns:
            作成されたTaskInfo
        """
        # 完了済みタスクが溜まり続けないよう、作成のたびに古いものを掃除する
        self.cleanup_old_tasks()

        task_id = str(uuid.uuid4())
        task = TaskInfo(id=task_id, total_files=total_files)

        with self._tasks_lock:
            self._tasks[task_id] = task

        return task

    def set_total(self, task_id: str, total_files: int) -> bool:
        """総ファイル数を更新する（スキャンしながら増やす用途）"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.total_files = max(0, total_files)
            if task.total_files > 0:
                task.progress = min(100, int((task.processed_files / task.total_files) * 100))
            return True

    def get_task(self, task_id: str) -> Optional[TaskInfo]:
        """タスク情報を取得"""
        with self._tasks_lock:
            return self._tasks.get(task_id)

    def update_progress(
        self,
        task_id: str,
        processed_files: int,
        current_file: str = "",
        status: Optional[TaskStatus] = None
    ) -> bool:
        """
        タスクの進捗を更新する
        
        Args:
            task_id: タスクID
            processed_files: 処理済みファイル数
            current_file: 現在処理中のファイル名
            status: ステータス（省略時は変更なし）
            
        Returns:
            更新成功時True、タスクが存在しない場合False
        """
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            
            task.processed_files = processed_files
            task.current_file = current_file
            
            if task.total_files > 0:
                task.progress = min(100, int((processed_files / task.total_files) * 100))
            
            if status:
                task.status = status
            
            return True

    def set_current_file(self, task_id: str, current_file: str) -> bool:
        """処理件数を変えずに、現在処理中の表示だけを更新する"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.current_file = current_file
            return True

    def set_running(self, task_id: str) -> bool:
        """タスクを実行中に設定"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.status = "running"
            return True

    def complete_task(self, task_id: str, result: Any = None) -> bool:
        """タスクを完了に設定"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.status = "completed"
            task.progress = 100
            task.result = result
            task.completed_at = datetime.now()
            return True

    def fail_task(self, task_id: str, error_message: str) -> bool:
        """タスクをエラーに設定"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.status = "error"
            task.error_message = error_message
            task.completed_at = datetime.now()
            return True

    def cancel_task(self, task_id: str) -> bool:
        """
        タスクのキャンセルをリクエストする
        
        実際のキャンセル処理はワーカースレッドがフラグを検知して行う
        """
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            if task.status in ("completed", "cancelled", "error"):
                return False  # 既に終了済み
            task.cancelled = True
            return True

    def is_cancelled(self, task_id: str) -> bool:
        """タスクがキャンセルされたかどうか"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            return task.cancelled

    def set_cancelled(self, task_id: str) -> bool:
        """タスクをキャンセル済みに設定"""
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            task.status = "cancelled"
            task.completed_at = datetime.now()
            return True

    def cleanup_old_tasks(self, max_age_seconds: int = 3600) -> int:
        """
        古いタスクを削除する
        
        Args:
            max_age_seconds: この秒数より古いタスクを削除
            
        Returns:
            削除したタスク数
        """
        now = datetime.now()
        to_delete = []
        
        with self._tasks_lock:
            for task_id, task in self._tasks.items():
                if task.completed_at:
                    age = (now - task.completed_at).total_seconds()
                    if age > max_age_seconds:
                        to_delete.append(task_id)
            
            for task_id in to_delete:
                del self._tasks[task_id]
        
        return len(to_delete)


# グローバルインスタンス
task_manager = TaskManager()
