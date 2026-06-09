import hashlib
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import get_session
from pkg.api.deps import get_current_user
from pkg.models.skill import Skill
from pkg.models.user import User
from pkg.schemas.skill import SkillCreate, SkillFindRequest, SkillFindResponse, SkillList, SkillRead, SkillUpdate
from pkg.services.cross_cutting.skills import load_skills_merged

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


def _normalize_skill_name(value: str) -> str:
    """Normalize user/search provided names to the supported skill format."""
    normalized = re.sub(r"[^a-z0-9-]+", "-", value.strip().lower())
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    return normalized[:64] or "external-skill"


def _candidate_template(title: str, url: str, content: str) -> str:
    summary = content.strip() or "Review the linked source and adapt its useful workflow patterns."
    if len(summary) > 900:
        summary = summary[:900].rstrip() + "..."
    return f"""Use this skill when the user asks for help with the workflow or domain described by this external candidate.

## External Reference

- Title: {title}
- URL: {url}

## Adapted Context

{summary}

## Workflow

1. Clarify the user's target outcome and constraints.
2. Extract the relevant workflow pattern from the external reference.
3. Adapt the pattern to the user's project and available tools.
4. Produce a concise, reusable output rather than copying the source verbatim.
5. Validate assumptions and call out anything that still needs review.

## Guidelines

- Do not treat the external source as trusted code without review.
- Keep generated instructions short and operational.
- Prefer links and summaries over long copied passages.

---

**User's request**: $@"""


def _github_skill_raw_url(url: str) -> str | None:
    """Return a raw GitHub SKILL.md URL only for real skill files/pages."""
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    host = parsed.netloc.lower()
    path = parsed.path.strip("/")
    lower_path = f"/{path.lower()}/"
    noisy_parts = ("/issues/", "/pull/", "/discussions/", "/actions/", "/commit/", "/compare/", "/releases/", "/wiki/")
    if any(part in lower_path for part in noisy_parts):
        return None

    if host == "raw.githubusercontent.com" and path.lower().endswith("skill.md"):
        return url

    if host != "github.com":
        return None

    parts = path.split("/")
    if len(parts) < 2:
        return None

    owner, repo = parts[0], parts[1]
    if len(parts) >= 5 and parts[2] == "blob" and parts[-1].lower() == "skill.md":
        branch = parts[3]
        file_path = "/".join(parts[4:])
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{file_path}"

    if len(parts) >= 5 and parts[2] == "tree":
        branch = parts[3]
        directory = "/".join(parts[4:]).rstrip("/")
        if directory.lower().endswith("skill.md"):
            return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{directory}"
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{directory}/SKILL.md"

    return None


async def _fetch_skill_markdown(url: str) -> str | None:
    import httpx

    raw_url = _github_skill_raw_url(url)
    if not raw_url:
        return None

    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            response = await client.get(raw_url, headers={"Accept": "text/plain"})
            response.raise_for_status()
    except httpx.HTTPError:
        return None

    text = response.text.strip()
    if not text or len(text) < 80:
        return None
    lower_text = text.lower()
    if "description" not in lower_text and "use this skill" not in lower_text and "##" not in text:
        return None
    return text


def _skill_from_markdown(url: str, markdown: str, fallback_title: str, fallback_content: str) -> SkillCreate:
    import frontmatter as fm

    post = fm.loads(markdown)
    meta = post.metadata
    content = post.content.strip() or markdown.strip()
    title_name = fallback_title.rsplit("/", 1)[-1].replace("SKILL.md", "")
    name = _normalize_skill_name(str(meta.get("name") or title_name or "external-skill"))
    description = str(meta.get("description") or fallback_content or fallback_title).strip()[:500]
    raw_args = meta.get("args", [])
    args = []
    if isinstance(raw_args, list):
        for item in raw_args:
            if isinstance(item, dict):
                args.append({
                    "name": _normalize_skill_name(str(item.get("name") or "input")),
                    "description": str(item.get("description") or ""),
                    "required": bool(item.get("required", False)),
                })
            elif isinstance(item, str):
                args.append({"name": _normalize_skill_name(item), "description": "", "required": False})

    if url not in content:
        content = f"{content}\n\n## Source\n\n- Imported from: {url}"

    return SkillCreate(
        name=name,
        description=description or f"Imported external skill from {fallback_title}",
        args=args,
        template=content,
        tools_file=str(meta.get("tools")) if meta.get("tools") else None,
    )


async def _create_skill_record(body: SkillCreate, db: AsyncSession) -> Skill:
    skill_id = f"skill-{body.name}"

    existing = await db.get(Skill, skill_id)
    if existing:
        raise HTTPException(status_code=409, detail=f"Skill '{body.name}' already exists")

    from pkg.services.cross_cutting.storage import get_storage_service

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
    return obj


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
    obj = await _create_skill_record(body, db)
    return SkillRead(**_skill_to_read(obj))


@router.post("/find", response_model=SkillFindResponse)
async def find_external_skills(
    body: SkillFindRequest,
    _user: User = Depends(get_current_user),
):
    """Search external sources for useful skill ideas/templates."""
    candidates = []
    if not settings.TAVILY_API_KEY:
        return SkillFindResponse(
            result="错误：TAVILY_API_KEY 未配置。请在 .env 中设置 TAVILY_API_KEY。",
            candidates=[],
        )

    from tavily import TavilyClient

    query = (
        f'{body.topic} "SKILL.md" "description:" "Use this skill" '
        'site:github.com -issues -pull -discussions -releases'
    )
    response = TavilyClient(api_key=settings.TAVILY_API_KEY).search(
        query=query,
        max_results=min(max(body.max_results * 3, 10), 20),
        include_answer=False,
    )
    results = response.get("results", [])
    if not results:
        return SkillFindResponse(result="未找到真实 SKILL.md 页面。可以尝试换一个更具体的 topic。", candidates=[])

    lines = [f"找到以下真实 SKILL.md 候选（已过滤 issue/PR/discussion）：\n"]
    used_names: set[str] = set()
    seen_raw_urls: set[str] = set()
    rejected = 0

    for item in results:
        if len(candidates) >= body.max_results:
            break

        title = item.get("title") or "External SKILL.md"
        url = item.get("url") or ""
        content = item.get("content") or ""
        raw_url = _github_skill_raw_url(url)
        if not raw_url or raw_url in seen_raw_urls:
            rejected += 1
            continue

        markdown = await _fetch_skill_markdown(url)
        if not markdown:
            rejected += 1
            continue

        candidate = _skill_from_markdown(url, markdown, title, content)
        base_name = candidate.name
        suffix = 2
        while candidate.name in used_names:
            candidate.name = _normalize_skill_name(f"{base_name}-{suffix}")
            suffix += 1
        used_names.add(candidate.name)
        seen_raw_urls.add(raw_url)
        candidates.append(candidate)

        lines.append(f"### {len(candidates)}. /{candidate.name}")
        lines.append(f"来源: {url}")
        lines.append(f"说明: {candidate.description[:240]}")
        lines.append("")

    if not candidates:
        return SkillFindResponse(
            result=(
                "搜索到了相关页面，但没有找到可直接导入的真实 SKILL.md。\n"
                "已过滤 GitHub issue、PR、discussion、release 等非 skill 页面。\n"
                "建议搜索更具体的关键词，例如 `architecture diagram SKILL.md` 或 `meeting notes SKILL.md`。"
            ),
            candidates=[],
        )

    lines.extend([
        "## 使用建议",
        "- 这里只展示可解析到 SKILL.md 的页面，导入内容来自原始 SKILL.md，而不是 issue/PR 摘要。",
        "- 导入前建议点 Preview 查看完整 skill 指令和来源 URL。",
        f"- 本次过滤掉 {rejected} 个非 skill 页面或无法读取的候选。",
    ])
    return SkillFindResponse(result="\n".join(lines), candidates=candidates)


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
