"""
ベクトル管理グローバル状態モジュール (VectorState)
仕様:
- モデル（ruri-v3-30m / ruri-v3-310m 等）のロード・保持、スレッドセーフなライフサイクル管理。
- VectorSearcher および GlossaryDictionary のシングルトン保持。
- ターゲットフォルダに対する差分インデックス同期実行および進捗状況の管理。
- シングルトンインスタンス vector_state を提供。
"""

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from app.config import BACKEND_DIR, PROJECT_ROOT_DIR, settings
from app.vector.db import get_model_db_path, get_model_identifier
from app.vector.dictionary import GlossaryDictionary
from app.vector.embedder import BaseEmbedder, Embedder, MockEmbedder, get_device_info
from app.vector.indexer import IndexProgress, IndexResult, VectorIndexManager
from app.vector.searcher import VectorSearcher

logger = logging.getLogger(__name__)


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

    def get_saved_model_path(self) -> str:
        """config.json に保存されているモデルパスを取得する（未保存ならデフォルト）"""
        if self.config_path.exists():
            try:
                data = json.loads(self.config_path.read_text(encoding="utf-8"))
                saved = data.get("selected_model") or data.get("model_path")
                if saved:
                    return str(saved)
            except Exception as e:
                logger.warning("VectorState: failed to read config.json: %s", e)

        # プロジェクトルートの config.json もチェック
        root_config = PROJECT_ROOT_DIR / "config.json"
        if root_config.exists():
            try:
                data = json.loads(root_config.read_text(encoding="utf-8"))
                saved = data.get("selected_model") or data.get("model_path")
                if saved:
                    return str(saved)
            except Exception:
                pass

        return self.default_light_path


    def save_model_selection(self, model_path: str) -> None:
        """選択されたモデルパスを config.json に永続化する"""
        try:
            current_data: Dict[str, Any] = {}
            if self.config_path.exists():
                try:
                    current_data = json.loads(self.config_path.read_text(encoding="utf-8"))
                except Exception:
                    current_data = {}

            current_data["selected_model"] = model_path
            current_data["selected_model_name"] = Path(model_path).name if model_path else "default"
            current_data["updated_at"] = datetime.now().isoformat()

            self.config_path.write_text(json.dumps(current_data, ensure_ascii=False, indent=2), encoding="utf-8")
            logger.info("VectorState: saved selected model to %s: %s", self.config_path, model_path)
        except Exception as e:
            logger.error("VectorState: failed to save config.json: %s", e)

    @property
    def is_loaded(self) -> bool:
        return self.embedder is not None

    def load_saved_model(self) -> Dict[str, Any]:
        """config.json に保存されたモデルを自動ロードする。見つからない場合はクラッシュせず待機状態とする"""
        saved_path = self.get_saved_model_path()
        if saved_path == "mock_model":
            return self.load_model(use_mock=True)

        resolved = self.resolve_model_path(saved_path)
        if resolved is None:
            logger.warning(
                "VectorState: 有効なモデルフォルダが見つかりませんでした (models/ または backend/models/)。ベクトル検索は未ロード状態で待機します。"
            )
            return {"loaded": False, "message": "モデルフォルダが見つかりません"}

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
                ident = "mock"
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

            # 選択されたモデルを config.json に永続化
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
        """モデルが未ロードなら config.json またはデフォルトモデルのロードを試みる"""
        if self.is_loaded:
            return True
        try:
            self.load_saved_model()
            return True
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

    def sync_index(
        self,
        target_folders: List[str],
        force: bool = False,
        progress_callback: Optional[Callable[[IndexProgress], None]] = None,
        exclude_keywords: str = "",
        selected_extensions: Optional[Sequence[str]] = None,
        custom_content_extensions: Sequence[str] = (),
        custom_filename_extensions: Sequence[str] = (),
    ) -> Optional[IndexResult]:
        """ターゲットフォルダ群のベクトルインデックスを差分同期する"""
        if not self.ensure_model_loaded():
            logger.warning("VectorState: cannot sync vector index because model is not loaded")
            return None

        with self._lock:
            if self.is_indexing:
                logger.info("VectorState: indexing already in progress, skipping sync")
                return None
            self.is_indexing = True
            self.current_progress = None

        ident = get_model_identifier(self.model_path, self.embedder)
        db_path = get_model_db_path(ident, data_dir=self.data_dir)

        def _on_progress(p: IndexProgress):
            self.current_progress = p
            if progress_callback:
                progress_callback(p)

        # 設定ファイルからの拡張子解決（未指定時）
        effective_selected = selected_extensions
        effective_content = list(custom_content_extensions)
        effective_filename = list(custom_filename_extensions)
        if effective_selected is None:
            try:
                from app.services.index_service import IndexService
                idx_svc = IndexService()
                app_cfg = idx_svc.get_app_settings()
                effective_selected = [e.strip() for e in app_cfg.index_selected_extensions.splitlines() if e.strip()]
                if not effective_content:
                    effective_content = [e.strip() for e in app_cfg.custom_content_extensions.splitlines() if e.strip()]
                if not effective_filename:
                    effective_filename = [e.strip() for e in app_cfg.custom_filename_extensions.splitlines() if e.strip()]
            except Exception as e:
                logger.debug("VectorState: could not load app settings for extensions: %s", e)
                try:
                    from app.config import settings
                    ext_path = settings.index_selected_extensions_path
                    if ext_path.exists():
                        effective_selected = [e.strip() for e in ext_path.read_text(encoding="utf-8").splitlines() if e.strip()]
                except Exception:
                    pass

        try:
            manager = VectorIndexManager(
                target_folders=target_folders,
                db_path=db_path,
                embedder=self.embedder,
                glossary=self.glossary,
                exclude_keywords=exclude_keywords,
                selected_extensions=effective_selected,
                custom_content_extensions=effective_content,
                custom_filename_extensions=effective_filename,
            )
            result = manager.index_all(force_reindex=force, progress_callback=_on_progress)
            self.last_result = result
            if self.searcher:
                self.searcher.reset_index()
            return result
        finally:
            with self._lock:
                self.is_indexing = False



vector_state = VectorState()
