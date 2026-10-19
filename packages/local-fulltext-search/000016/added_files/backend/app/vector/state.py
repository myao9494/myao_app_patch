"""
ベクトル管理グローバル状態モジュール (VectorState)
仕様:
- モデル（ruri-v3-30m / ruri-v3-310m 等）のロード・保持、スレッドセーフなライフサイクル管理。
- 以前使用したモデル選択状態を config.json に永続化し、サーバー起動時に自動復元（初回や未記録時は未ロード状態で待機）。
- mock_model などのテスト用ダミーモデルは永続化せず、設定ファイルの汚染を防止。
- VectorSearcher および GlossaryDictionary のシングルトン保持。
- ターゲットフォルダに対する差分インデックス同期実行および進捗状況の管理。
  同期は同時に 1 つだけ実行する。実行中に来た差分同期の要求は捨てずに覚えておき、今の同期が終わったら続けて実行する。
  実行中の同期は request_cancel で中止できる（覚えておいた要求も破棄する）。
- 同期で文書が追加・更新・削除されたときだけ、同期の処理の中で検索用の FAISS インデックスを作り直して差し替える。
  変更の無い同期では作成済みのインデックスを捨てない（検索に全ベクトルの読み直しを待たせないため）。
- シングルトンインスタンス vector_state を提供。
"""

import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from app.config import BACKEND_DIR, PROJECT_ROOT_DIR, settings
from app.services.app_settings_store import load_app_settings
from app.vector.db import get_model_db_path, get_model_identifier
from app.vector.dictionary import GlossaryDictionary
from app.vector.embedder import BaseEmbedder, Embedder, MockEmbedder, get_device_info
from app.vector.indexer import IndexProgress, IndexResult, VectorIndexManager
from app.vector.searcher import VectorSearcher

logger = logging.getLogger(__name__)


def has_index_changes(result: Optional[IndexResult]) -> bool:
    """同期でベクトルDBの文書が追加・更新・削除されたかを返す。"""
    if result is None:
        return False
    return (result.new_count + result.updated_count + result.deleted_count) > 0


@dataclass(frozen=True)
class _SyncRequest:
    """ベクトルインデックス同期 1 回分の指示。"""

    target_folders: tuple[str, ...]
    force: bool
    clean_deleted_files: bool
    progress_callback: Optional[Callable[[IndexProgress], None]]
    exclude_keywords: Optional[str]
    selected_extensions: Optional[tuple[str, ...]]
    custom_content_extensions: tuple[str, ...]
    custom_filename_extensions: tuple[str, ...]
    folder_depths: Optional[Mapping[str, int]]


class VectorState:
    """ベクトル機能のグローバル状態管理クラス"""

    def __init__(self, data_dir: Optional[Path] = None):
        self.data_dir = data_dir or settings.data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = self.data_dir / "config.json"
        self.model_path: Optional[str] = None
        self.model_name: str = "light"
        self.embedder: Optional[BaseEmbedder] = None
        self.glossary: Optional[GlossaryDictionary] = None
        self.searcher: Optional[VectorSearcher] = None
        self.is_indexing: bool = False
        self.current_progress: Optional[IndexProgress] = None
        self.last_result: Optional[IndexResult] = None
        self._lock = threading.Lock()
        self._cancel_requested = threading.Event()
        # 同期の実行中に受け取った差分同期の要求（対象フォルダの組ごとに最新の 1 件）
        self._pending_requests: Dict[tuple[str, ...], _SyncRequest] = {}

        # デフォルトモデルパスの候補設定および探索ディレクトリ
        self.model_search_dirs = [
            PROJECT_ROOT_DIR / "models",
            PROJECT_ROOT_DIR / "backend" / "models",
            BACKEND_DIR / "models",
        ]
        self.default_light_name = "ruri-v3-30m"
        self.default_standard_name = "ruri-v3-310m"

    @property
    def default_light_path(self) -> str:
        p = self.resolve_model_path(self.default_light_name)
        return str(p) if p else str(PROJECT_ROOT_DIR / "models" / self.default_light_name)

    @property
    def default_standard_path(self) -> str:
        p = self.resolve_model_path(self.default_standard_name)
        return str(p) if p else str(PROJECT_ROOT_DIR / "models" / self.default_standard_name)

    def resolve_model_path(self, path_or_name: Optional[str] = None) -> Optional[Path]:
        """
        指定されたパスまたはモデル名から、有効なモデルディレクトリ（config.jsonが存在するフォルダ）を解決する。
        models/ または backend/models/ の配置、および異OS絶対パスからのフォルダ名解決に対応する。
        """
        # 1. 直接指定されたパスの検証
        if path_or_name:
            p = Path(path_or_name)
            # 探索ディレクトリ配下にあるか、または明示的に指定された実在ディレクトリ
            if p.is_dir() and (p / "config.json").exists():
                is_within_search_dirs = any(
                    str(p.resolve()).startswith(str(d.resolve())) for d in self.model_search_dirs if d.exists()
                )
                if is_within_search_dirs or not self.model_search_dirs:
                    return p.resolve()

            # 相対パスとしての探索（絶対パスの場合は search_dir と結合しない）
            if not p.is_absolute():
                for search_dir in self.model_search_dirs:
                    candidate = search_dir / path_or_name
                    if candidate.is_dir() and (candidate / "config.json").exists():
                        return candidate.resolve()

            # 他OSの絶対パス等から末尾のディレクトリ名のみを取り出して探索
            model_dir_name = p.name
            if model_dir_name:
                for search_dir in self.model_search_dirs:
                    candidate = search_dir / model_dir_name
                    if candidate.is_dir() and (candidate / "config.json").exists():
                        return candidate.resolve()


        # 2. 未指定または見つからなかった場合、既定モデル名の優先探索
        preferred_names = ["ruri-v3-30m", "ruri-v3-310m", "ruri-v3-70m"]
        for name in preferred_names:
            for search_dir in self.model_search_dirs:
                candidate = search_dir / name
                if candidate.is_dir() and (candidate / "config.json").exists():
                    return candidate.resolve()

        # 3. 探索ディレクトリ内の任意のモデルフォルダを走査
        for search_dir in self.model_search_dirs:
            if search_dir.is_dir():
                for sub in search_dir.iterdir():
                    if sub.is_dir() and (sub / "config.json").exists():
                        return sub.resolve()

        return None

    def get_saved_model_path(self) -> Optional[str]:
        """config.json に保存されているモデルパスを取得する（未保存またはテスト用モデルなら None）"""
        if self.config_path.exists():
            try:
                data = json.loads(self.config_path.read_text(encoding="utf-8"))
                saved = data.get("selected_model") or data.get("model_path")
                if saved and str(saved).strip() and str(saved).strip() != "mock_model":
                    return str(saved).strip()
            except (AttributeError, OSError, ValueError) as e:
                logger.warning("VectorState: failed to read config.json: %s", e)

        # プロジェクトルートの config.json もチェック
        root_config = PROJECT_ROOT_DIR / "config.json"
        if root_config.exists():
            try:
                data = json.loads(root_config.read_text(encoding="utf-8"))
                saved = data.get("selected_model") or data.get("model_path")
                if saved and str(saved).strip() and str(saved).strip() != "mock_model":
                    return str(saved).strip()
            except (AttributeError, OSError, ValueError):
                logger.warning("Failed to read the saved vector model setting: %s", root_config, exc_info=True)

        return None

    def save_model_selection(self, model_path: Optional[str]) -> None:
        """選択されたモデルパスを config.json に永続化する（mock_model 等のテスト用モデルは保存しない）"""
        if not model_path or model_path == "mock_model":
            return

        try:
            current_data: Dict[str, Any] = {}
            if self.config_path.exists():
                try:
                    current_data = json.loads(self.config_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    current_data = {}

            current_data["selected_model"] = model_path
            current_data["selected_model_name"] = Path(model_path).name if model_path else "default"
            current_data["updated_at"] = datetime.now().isoformat()

            self.config_path.write_text(json.dumps(current_data, ensure_ascii=False, indent=2), encoding="utf-8")
            logger.info("VectorState: saved selected model to %s: %s", self.config_path, model_path)
        except (OSError, TypeError, ValueError) as e:
            logger.error("VectorState: failed to save config.json: %s", e)

    @property
    def is_loaded(self) -> bool:
        return self.embedder is not None

    def load_saved_model(self) -> Dict[str, Any]:
        """config.json に保存されたモデルを自動ロードする。記録がない場合はロードせず待機状態とする"""
        saved_path = self.get_saved_model_path()
        if not saved_path:
            logger.info("VectorState: 記録されたモデル設定がないため、自動ロードをスキップします（未ロード状態で待機）。")
            return {"loaded": False, "message": "保存されたモデルがありません"}

        resolved = self.resolve_model_path(saved_path)
        if resolved is None:
            logger.warning(
                "VectorState: 保存されたモデルパス '%s' のフォルダが見つかりませんでした。未ロード状態で待機します。",
                saved_path,
            )
            return {"loaded": False, "message": f"モデルフォルダが見つかりません: {saved_path}"}

        return self.load_model(model_path=str(resolved))

    def load_model(
        self,
        model_path: Optional[str] = None,
        use_mock: bool = False,
        mock_dim: int = 256,
    ) -> Dict[str, Any]:
        """モデルをロードし、検索エンジンを初期化して config.json に保存する"""
        with self._lock:
            if use_mock:
                self.embedder = MockEmbedder(dim=mock_dim, model_path="mock_model")
                self.model_path = "mock_model"
                # 検索器が読むDBと sync_index が書くDBを一致させるため、実モデルと同じ規則で識別子を決める
                ident = get_model_identifier(self.model_path)
            else:
                resolved = self.resolve_model_path(model_path)
                if resolved is None:
                    raise ValueError(
                        f"モデルパスが見つかりません: {model_path} (models/ または backend/models/ に配置してください)"
                    )
                target_path = str(resolved)

                # 分割モデルパーツがある場合は自動結合して復元 (GitHub 100MB 制限対応)
                try:
                    from app.vector.model_bundler import ensure_model_files
                    ensure_model_files(Path(target_path))
                except Exception as e:
                    logger.debug("model_bundler skipped: %s", e)

                self.embedder = Embedder(target_path)
                self.model_path = target_path
                ident = get_model_identifier(target_path)

            db_path = get_model_db_path(ident, data_dir=self.data_dir)

            # 辞書の探索（一元管理された synonym_groups.txt を最優先、フォールバックで glossary.xlsx / glossary.csv）
            glossary_path = self.data_dir / "synonym_groups.txt"
            if not glossary_path.exists():
                glossary_path = self.data_dir / "glossary.xlsx"
            if not glossary_path.exists():
                glossary_path = self.data_dir / "glossary.csv"
            if glossary_path.exists():
                self.glossary = GlossaryDictionary(str(glossary_path))
            else:
                self.glossary = None

            self.searcher = VectorSearcher(
                db_path=db_path,
                embedder=self.embedder,
                glossary=self.glossary,
            )

            # 選択されたモデルを config.json に永続化（mock以外）
            if not use_mock and self.model_path != "mock_model":
                self.save_model_selection(self.model_path)

            device_info = get_device_info()
            current_device = getattr(self.embedder, "device", device_info.get("device", "cpu"))

            logger.info("VectorState: model loaded (%s, dim=%d, device=%s)", ident, self.embedder.embedding_dim, current_device)
            return {
                "loaded": True,
                "model_path": self.model_path,
                "dim": self.embedder.embedding_dim,
                "is_mock": use_mock,
                "device": current_device,
                "device_name": device_info.get("device_name", "CPU"),
                "cuda_available": device_info.get("cuda_available", False),
                "mps_available": device_info.get("mps_available", False),
            }

    def ensure_model_loaded(self) -> bool:
        """モデルが未ロードなら config.json に保存されたモデルのロードを試みる（記録がなければロードしない）"""
        if self.is_loaded:
            return True
        saved_path = self.get_saved_model_path()
        if not saved_path:
            return False
        try:
            res = self.load_saved_model()
            return bool(res.get("loaded", False))
        except Exception as e:
            logger.warning("VectorState: auto load model failed: %s", e)
            return False

    def get_searcher(self) -> Optional[VectorSearcher]:
        """ロード済みの VectorSearcher を取得する"""
        if not self.is_loaded:
            self.ensure_model_loaded()
        return self.searcher

    def reload_glossary(self) -> None:
        """一元管理された類似語・専門用語辞書を再読み込みする"""
        glossary_path = self.data_dir / "synonym_groups.txt"
        if not glossary_path.exists():
            glossary_path = self.data_dir / "glossary.xlsx"
        if not glossary_path.exists():
            glossary_path = self.data_dir / "glossary.csv"
        if glossary_path.exists():
            if self.glossary:
                self.glossary.file_path = str(glossary_path)
                self.glossary.load(force=True)
            else:
                self.glossary = GlossaryDictionary(str(glossary_path))
            if self.searcher:
                self.searcher.glossary = self.glossary
            logger.info("VectorState: 類似語・専門用語辞書をリロードしました (%d 件)", len(self.glossary.entries) if self.glossary else 0)

    def request_cancel(self) -> bool:
        """実行中のインデックス同期へ中止を要求する。実行中でなければ何もせず False を返す。"""
        with self._lock:
            if not self.is_indexing:
                return False
            self._cancel_requested.set()
            self._pending_requests.clear()
            return True

    def sync_index(
        self,
        target_folders: List[str],
        force: bool = False,
        clean_deleted_files: bool = False,
        progress_callback: Optional[Callable[[IndexProgress], None]] = None,
        exclude_keywords: Optional[str] = None,
        selected_extensions: Optional[Sequence[str]] = None,
        custom_content_extensions: Sequence[str] = (),
        custom_filename_extensions: Sequence[str] = (),
        folder_depths: Optional[Mapping[str, int]] = None,
    ) -> Optional[IndexResult]:
        """
        ターゲットフォルダ群のベクトルインデックスを差分同期する。
        別の同期が実行中のときは None を返す。差分同期（force=False）の要求は覚えておき、
        実行中の同期を始めた呼び出しが、終わったあとに続けて実行する。
        """
        if not self.ensure_model_loaded():
            logger.debug("VectorState: vector sync skipped because no model is loaded")
            return None

        request = _SyncRequest(
            target_folders=tuple(target_folders),
            force=force,
            clean_deleted_files=clean_deleted_files,
            progress_callback=progress_callback,
            exclude_keywords=exclude_keywords,
            selected_extensions=tuple(selected_extensions) if selected_extensions is not None else None,
            custom_content_extensions=tuple(custom_content_extensions),
            custom_filename_extensions=tuple(custom_filename_extensions),
            folder_depths=folder_depths,
        )
        with self._lock:
            if self.is_indexing:
                if not force:
                    self._pending_requests[request.target_folders] = request
                    logger.info("VectorState: indexing already in progress, queued sync for %s", target_folders)
                else:
                    logger.info("VectorState: indexing already in progress, skipping sync")
                return None
            self.is_indexing = True
            self.current_progress = None
            self._cancel_requested.clear()

        try:
            result = self._run_sync(request)
            while True:
                with self._lock:
                    if not self._pending_requests or self._cancel_requested.is_set():
                        self._pending_requests.clear()
                        break
                    queued_request = self._pending_requests.pop(next(iter(self._pending_requests)))
                try:
                    self._run_sync(queued_request)
                except Exception:
                    # 後から来た要求の失敗で、最初の呼び出しの結果を失わせない
                    logger.warning(
                        "VectorState: queued vector sync failed for %s", queued_request.target_folders, exc_info=True
                    )
            return result
        finally:
            with self._lock:
                self.is_indexing = False

    def _run_sync(self, request: _SyncRequest) -> Optional[IndexResult]:
        """同期 1 回分を実行する。設定を読めないときは何もせず None を返す。"""
        ident = get_model_identifier(self.model_path, self.embedder)
        db_path = get_model_db_path(ident, data_dir=self.data_dir)

        def _on_progress(p: IndexProgress):
            self.current_progress = p
            if request.progress_callback:
                request.progress_callback(p)

        # 設定ファイルからの拡張子および除外キーワード解決（未指定時）
        effective_selected: Optional[Sequence[str]] = request.selected_extensions
        effective_content = list(request.custom_content_extensions)
        effective_filename = list(request.custom_filename_extensions)
        effective_exclude = request.exclude_keywords
        if effective_selected is None or effective_exclude is None:
            try:
                app_cfg = load_app_settings()
                if effective_selected is None:
                    effective_selected = app_cfg.index_selected_extensions.splitlines()
                if not effective_content:
                    effective_content = app_cfg.custom_content_extensions.splitlines()
                if not effective_filename:
                    effective_filename = app_cfg.custom_filename_extensions.splitlines()
                if effective_exclude is None:
                    effective_exclude = app_cfg.exclude_keywords
            except Exception:
                # 設定を読めない場合に拡張子・除外の絞り込みなしで走査すると意図しないファイルまで
                # インデックスしてしまうため、同期を中止して次回に委ねる
                logger.warning("VectorState: failed to load app settings, vector sync skipped.", exc_info=True)
                return None

        manager = VectorIndexManager(
            target_folders=list(request.target_folders),
            db_path=db_path,
            embedder=self.embedder,
            glossary=self.glossary,
            exclude_keywords=effective_exclude or "",
            selected_extensions=effective_selected,
            custom_content_extensions=effective_content,
            custom_filename_extensions=effective_filename,
            folder_depths=request.folder_depths,
        )
        result = manager.index_all(
            force_reindex=request.force,
            clean_deleted_files=request.clean_deleted_files,
            progress_callback=_on_progress,
            should_cancel=self._cancel_requested.is_set,
        )
        self.last_result = result
        # 内容が変わったときだけ、この同期の処理の中で FAISS インデックスを作り直して差し替える。
        # 検索の側で作り直しを待たせないため（変更が無い同期では作成済みのインデックスをそのまま使う）。
        if self.searcher and has_index_changes(result):
            self.searcher.rebuild_index()
        return result

    def get_pending_deletions(
        self,
        target_folders: List[str],
        model_path: Optional[str] = None,
        folder_depths: Optional[Mapping[str, int]] = None,
    ) -> List[str]:
        """
        指定モデルおよびターゲットフォルダ群において、インデックスから削除対象となるファイル一覧を高速に算出する。
        """
        ident = get_model_identifier(model_path or self.model_path, self.embedder)
        db_path = get_model_db_path(ident, data_dir=self.data_dir)

        app_cfg = load_app_settings()
        selected = app_cfg.index_selected_extensions.splitlines()
        content = app_cfg.custom_content_extensions.splitlines()
        filename = app_cfg.custom_filename_extensions.splitlines()
        exclude = app_cfg.exclude_keywords

        manager = VectorIndexManager(
            target_folders=target_folders,
            db_path=db_path,
            embedder=None,
            glossary=None,
            exclude_keywords=exclude,
            selected_extensions=selected,
            custom_content_extensions=content,
            custom_filename_extensions=filename,
            folder_depths=folder_depths,
        )
        return manager.get_pending_deletions()



vector_state = VectorState()
