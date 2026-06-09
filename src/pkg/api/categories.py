import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import get_session
from pkg.models.category import Category
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.schemas.category import CategoryCreate, CategoryList, CategoryRead, CategoryUpdate

router = APIRouter()
logger = logging.getLogger(__name__)


async def get_default_category_id(session: AsyncSession) -> int:
    """Return the id of the 'general' category."""
    stmt = select(Category.id).where(Category.name == "general")
    result = await session.execute(stmt)
    cat_id = result.scalar()
    if cat_id is None:
        raise HTTPException(status_code=500, detail="Default 'general' category not found")
    return cat_id


@router.post("", response_model=CategoryRead, status_code=201)
async def create_category(body: CategoryCreate, session: AsyncSession = Depends(get_session)):
    existing = await session.execute(select(Category).where(Category.name == body.name))
    if existing.scalar():
        raise HTTPException(status_code=409, detail=f"Category '{body.name}' already exists")

    category = Category(
        name=body.name,
        display_name=body.display_name,
        description=body.description,
    )
    session.add(category)
    await session.commit()
    await session.refresh(category)
    return category


@router.get("", response_model=CategoryList)
async def list_categories(session: AsyncSession = Depends(get_session)):
    stmt = select(Category).order_by(Category.name)
    result = await session.execute(stmt)
    items = list(result.scalars())
    return CategoryList(items=items, total=len(items))


@router.get("/{category_id}", response_model=CategoryRead)
async def get_category(category_id: int, session: AsyncSession = Depends(get_session)):
    category = await session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    return category


@router.patch("/{category_id}", response_model=CategoryRead)
async def update_category(
    category_id: int,
    body: CategoryUpdate,
    session: AsyncSession = Depends(get_session),
):
    category = await session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    patch = body.model_dump(exclude_unset=True)
    for key, value in patch.items():
        setattr(category, key, value)

    await session.commit()
    await session.refresh(category)
    return category


@router.delete("/{category_id}", status_code=204)
async def delete_category(category_id: int, session: AsyncSession = Depends(get_session)):
    category = await session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    if category.name == "general":
        raise HTTPException(status_code=400, detail="Cannot delete the default 'general' category")

    # Check for references
    note_count = (await session.execute(
        select(func.count()).select_from(Note).where(Note.category_id == category_id)
    )).scalar() or 0
    source_count = (await session.execute(
        select(func.count()).select_from(Source).where(Source.category_id == category_id)
    )).scalar() or 0

    if note_count > 0 or source_count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Category still has {note_count} notes and {source_count} sources. Reassign them first.",
        )

    await session.delete(category)
    await session.commit()
