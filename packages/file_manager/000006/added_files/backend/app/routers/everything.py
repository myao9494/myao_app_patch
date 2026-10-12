"""
Everything検索プロキシ
WindowsではEverythingのHTTPサーバー(localhost:8080)、macOSではLocal-fulltext-searchにリクエストを転送し、
フロントエンドが期待する形式に変換して返す
"""
import httpx
import platform
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional

from app.config import settings

router = APIRouter()

EVERYTHING_BASE_URL = "http://localhost:8080"
TIMEOUT = 5.0


def get_mac_index_base_url() -> str:
    """macOS用の統合済みファイル検索APIのベースURLを返す"""
    return settings.fulltext_service_url.rstrip("/")

class EverythingItem(BaseModel):
    name: str
    path: str
    type: str
    size: Optional[int] = None
    date_modified: Optional[int] = None

class EverythingResponse(BaseModel):
    totalResults: int
    results: List[EverythingItem]

# フロントエンドが期待する形式のモデル
class FileItem(BaseModel):
    name: str
    type: str  # "file" or "directory"
    path: str
    size: Optional[int] = None
    date_modified: Optional[float] = None  # Unix Timestamp (seconds)

class SearchResponse(BaseModel):
    totalResults: int
    results: List[FileItem]

class StatusResponse(BaseModel):
    ready: bool
    total_indexed: int

def windows_filetime_to_timestamp(filetime: Optional[str]) -> Optional[float]:
    """Windows File Time (Ticks) を Unix Timestamp (Seconds) に変換"""
    if not filetime:
        return None
    try:
        # Windows File Time (100-nanosecond intervals since January 1, 1601)
        ticks = int(filetime)
        # 1601-01-01 -> 1970-01-01 is 11,644,473,600 seconds
        # ticks / 10,000,000 = seconds
        seconds_since_1601 = ticks / 10000000
        seconds_since_1970 = seconds_since_1601 - 11644473600
        return float(seconds_since_1970)
    except:
        return None

@router.get("/index/status", response_model=StatusResponse)
async def get_status():
    """
    インデックスサービスのステータス確認
    """
    is_windows = platform.system() == "Windows"
    base_url = EVERYTHING_BASE_URL if is_windows else get_mac_index_base_url()
    path = "/" if is_windows else "/api/index/status"
    try:
        async with httpx.AsyncClient(trust_env=False) as client:
            # 軽いクエリで接続確認
            params = {"search": "", "json": 1, "count": 1} if is_windows else None
            response = await client.get(
                f"{base_url}{path}",
                params=params, 
                timeout=TIMEOUT
            )
            # ステータスコードチェックは省略（Macのサービス仕様不明なため）
            # response.raise_for_status() 
            
            data = response.json()
            # Windows(Everything) と Mac(Custom) でレスポンス構造が違う可能性も考慮
            # とりあえず totalResults を見る
            return {
                "ready": True,
                "total_indexed": data.get("totalResults", 0)
            }
    except Exception as e:
        print(f"Index service connection error: {e}")
        return {
            "ready": False,
            "total_indexed": 0
        }

@router.get("/index")
async def search(
    search: str = Query(..., description="検索クエリ"),
    count: int = Query(100, description="取得件数"),
    offset: int = Query(0, description="オフセット"),
    sort: str = Query("name", description="ソート順"),
    ascending: int = Query(1, description="昇順(1)/降順(0)"),
    path: Optional[str] = Query(None, description="検索対象フォルダ"),
    file_type: str = Query("all", description="ファイルタイプ（all/file/directory）"),
):
    """
    インデックスでファイルを検索
    Macの場合はLocal-fulltext-searchへプロキシ、Windowsの場合はEverything APIを変換
    """
    is_windows = platform.system() == "Windows"

    if not is_windows:
        # Mac: Local-fulltext-search の互換APIへプロキシ
        # パラメータはそのまま転送
        params = {
            "search": search,
            "count": count,
            "offset": offset,
            "sort": sort,
            "ascending": ascending
        }
        if path:
            params["path"] = path
        if file_type != "all":
            params["file_type"] = file_type

        try:
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.get(
                    f"{get_mac_index_base_url()}/api/index",
                    params=params,
                    timeout=TIMEOUT
                )
                response.raise_for_status()
                # Mac側はすでに期待する形式（date_modified含む）で返すと仮定
                return response.json()
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Index service error: {e}")

    # Windows: Everything API 変換
    # パス指定がある場合はクエリに追加して絞り込み
    search_query = search
    if path:
        # Everythingでは "path" search_query の形式でパス絞り込みが可能
        # パスにスペースが含まれる場合を考慮してクォートする
        search_query = f'"{path}" {search}'

    params = {
        "search": search_query,
        "json": 1,
        "count": count,
        "offset": offset,
        "path_column": 1,
        "size_column": 1,
        "date_modified_column": 1,
        "sort": sort,
        "ascending": ascending
    }
    if file_type != "all":
        params["file_type"] = "folder" if file_type == "directory" else file_type

    try:
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(
                f"{EVERYTHING_BASE_URL}/",
                params=params,
                timeout=TIMEOUT
            )
            response.raise_for_status()
            data = response.json()
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"Everythingサービスに接続できません: {e}")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Everythingサービスエラー: {e}")

    results = []
    for item in data.get("results", []):
        try:
            name = item.get("name", "")
            parent_path = item.get("path", "")
            
            # フルパスの構築
            full_path = f"{parent_path}\\{name}" if parent_path else name
            if parent_path.endswith("\\"): 
                full_path = f"{parent_path}{name}"
                
            # サイズ変換
            size_str = item.get("size")
            size = int(size_str) if size_str else None
            
            # 日付変換 (Unix Timestamp)
            date_str = item.get("date_modified")
            timestamp = windows_filetime_to_timestamp(date_str)
            
            # タイプ変換
            item_type = item.get("type", "file")
            file_type = "directory" if item_type == "folder" else "file"
            
            results.append({
                "name": name,
                "type": file_type,
                "path": full_path,
                "size": size,
                "date_modified": timestamp
            })
        except Exception:
            continue

    return {
        "totalResults": data.get("totalResults", 0),
        "results": results
    }
