"""
リンク（タスク間の依存関係）APIルーター。
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Link as LinkModel
from schemas import Link, LinkCreate
from services import update_sequence

router = APIRouter(prefix="/api/links", tags=["links"])


def _get_link_or_404(db: Session, link_id: int) -> LinkModel:
    link = db.get(LinkModel, link_id)
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    return link


@router.get("", response_model=List[Link])
def get_all_links(db: Session = Depends(get_db)):
    """Get all links."""
    return db.query(LinkModel).all()


@router.post("", response_model=Link)
def create_link(link: LinkCreate, db: Session = Depends(get_db)):
    """Create a new link."""
    db_link = LinkModel(
        source=link.source,
        target=link.target,
        type=link.type or 0,
    )
    db.add(db_link)
    db.commit()
    update_sequence.increment()
    db.refresh(db_link)
    return db_link


@router.put("/{link_id}", response_model=Link)
def update_link(link_id: int, link: LinkCreate, db: Session = Depends(get_db)):
    """Update an existing link."""
    db_link = _get_link_or_404(db, link_id)

    db_link.source = link.source
    db_link.target = link.target
    db_link.type = link.type if link.type is not None else db_link.type

    db.commit()
    update_sequence.increment()
    db.refresh(db_link)
    return db_link


@router.delete("/{link_id}")
def delete_link(link_id: int, db: Session = Depends(get_db)):
    """Delete a link."""
    db.delete(_get_link_or_404(db, link_id))
    db.commit()
    update_sequence.increment()
    return {"message": "Link deleted"}
