"""
同義語APIルーター。
外部の Local-fulltext-search API から同義語グループを取得して中継する。
外部APIが使えない場合は 502 を返し、フロントエンドは通常検索にフォールバックする。
"""
import httpx
from fastapi import APIRouter, HTTPException

from config import synonym_api_url
from schemas import SynonymGroupsResponse

router = APIRouter(prefix="/api", tags=["synonyms"])


@router.get("/synonyms", response_model=SynonymGroupsResponse)
async def get_synonyms():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(synonym_api_url())
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="failed to fetch synonyms") from exc

    groups = response.json().get("groups", [])
    if not isinstance(groups, list):
        raise HTTPException(status_code=502, detail="invalid synonyms payload")

    normalized_groups: list[list[str]] = []
    for group in groups:
        if not isinstance(group, list):
            continue
        normalized_group = [str(word).strip() for word in group if str(word).strip()]
        if normalized_group:
            normalized_groups.append(normalized_group)

    return {"groups": normalized_groups}
