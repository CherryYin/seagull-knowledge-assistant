import hashlib

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import get_session
from pkg.api.deps import get_current_user
from pkg.models.skill import Skill
from pkg.models.user import User
from pkg.schemas.skill import SkillCreate, SkillList, SkillRead, SkillUpdate
from pkg.services.skills import load_skills_merged

router = APIRouter()


def _skill_to_read(s, source: str = "db") -> dict:
    """Convert a Skill ORM object to SkillRead-compatible dict."""
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "args": s.args or [],
        "template": s.template,
        "tools_file": s.tools_file,
        "file_path": s.file_path,
        "source": source,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


@router.get("", response_model=list[SkillRead])
async def list_skills(user: User = Depends(get_current_user)):
    """List all skills merged from local files and DB."""
    skills = await load_skills_merged(settings.skills_dir)
    return [
        SkillRead(
            id=f"skill-{s.name}",
            name=s.name,
            description=s.description,
            args=[{"name": a.name, "description": a.description, "required": a.required} for a in s.args],
            template=s.template,
            tools_file=s.tools_file,
            file_path=s.file_path,
            source=s.source,
        )
        for s in skills
    ]


@router.post("", response_model=SkillRead, status_code=201)
async def create_skill(
    body: SkillCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Create a new skill in DB + OSS."""
    skill_id = f"skill-{body.name}"

    existing = await db.get(Skill, skill_id)
    if existing:
        raise HTTPException(status_code=409, detail=f"Skill '{body.name}' already exists")

    # Upload to OSS
    from pkg.services.storage import get_storage_service
    storage = get_storage_service()
    object_key = storage.build_object_key("skills", skill_id, f"{body.name}.md")

    import frontmatter as fm
    post = fm.Post(
        content=body.template,
        handler=fm.YAMLHandler(),
        name=body.name,
        description=body.description,
        args=[a.model_dump() for a in body.args],
    )
    if body.tools_file:
        post.metadata["tools"] = body.tools_file
    raw_content = fm.dumps(post)

    storage_uri = await storage.upload_bytes(
        object_key=object_key,
        data=raw_content.encode("utf-8"),
        content_type="text/markdown",
    )

    content_hash = hashlib.sha256(raw_content.encode()).hexdigest()

    obj = Skill(
        id=skill_id,
        name=body.name,
        description=body.description,
        args=[a.model_dump() for a in body.args],
        template=body.template,
        tools_file=body.tools_file,
        file_path=storage_uri,
        content_hash=content_hash,
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)

    return SkillRead(**_skill_to_read(obj))


@router.get("/{skill_name}", response_model=SkillRead)
async def get_skill(
    skill_name: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    skill_id = f"skill-{skill_name}"
    obj = await db.get(Skill, skill_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Skill not found")
    return SkillRead(**_skill_to_read(obj))


@router.patch("/{skill_name}", response_model=SkillRead)
async def update_skill(
    skill_name: str,
    body: SkillUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    skill_id = f"skill-{skill_name}"
    obj = await db.get(Skill, skill_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Skill not found")

    if body.description is not None:
        obj.description = body.description
    if body.args is not None:
        obj.args = [a.model_dump() for a in body.args]
    if body.template is not None:
        obj.template = body.template
    if body.tools_file is not None:
        obj.tools_file = body.tools_file

    await db.commit()
    await db.refresh(obj)
    return SkillRead(**_skill_to_read(obj))


@router.delete("/{skill_name}", status_code=204)
async def delete_skill(
    skill_name: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    skill_id = f"skill-{skill_name}"
    obj = await db.get(Skill, skill_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Skill not found")
    await db.delete(obj)
    await db.commit()
