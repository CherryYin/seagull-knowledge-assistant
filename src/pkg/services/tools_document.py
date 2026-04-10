"""Document processing tool — delegates to document-oriented skills via a sub-agent.

The main Action Agent can call this tool when the user's request involves
document operations (PDF, Word, Excel, PowerPoint, or documentation co-authoring).
Internally it:
1. Selects the appropriate skill (auto-detect or explicit)
2. Expands the skill template
3. Spawns a lightweight sub-Agent with the skill prompt as system context
4. Returns the sub-agent's response
"""
import logging
import re

from strands import Agent, tool

from pkg.config import settings
from pkg.services.llm import create_model
from pkg.services.skills import expand_skill, load_skills_from_dir

logger = logging.getLogger(__name__)

# Supported document skills
_DOC_SKILLS = {"pdf", "xlsx", "pptx", "docx", "doc-coauthoring"}

# Keyword → skill mapping for auto-detection
_DETECT_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\.pdf\b|pdf\s*文件|pdf\s*file", re.IGNORECASE), "pdf"),
    (re.compile(r"\.xlsx\b|\.xlsm\b|\.csv\b|\.tsv\b|spreadsheet|excel|表格", re.IGNORECASE), "xlsx"),
    (re.compile(r"\.pptx?\b|slide|presentation|deck|幻灯片|演示", re.IGNORECASE), "pptx"),
    (re.compile(r"\.docx?\b|word\s*doc|word\s*文档", re.IGNORECASE), "docx"),
    (re.compile(r"\b(draft|proposal|spec|rfc|write\s+a?\s*doc|撰写|起草|文档协作|技术文档)\b", re.IGNORECASE), "doc-coauthoring"),
]


def _detect_skill(task: str) -> str | None:
    """Auto-detect which document skill matches the task description."""
    for pattern, skill_name in _DETECT_RULES:
        if pattern.search(task):
            return skill_name
    return None


def _load_doc_skill(skill_name: str) -> str | None:
    """Load a document skill template from the local skills directory."""
    skills = load_skills_from_dir(settings.skills_dir)
    for s in skills:
        if s.name == skill_name:
            return s.template
    return None


@tool
async def process_document(task: str, skill: str = "auto") -> str:
    """Process documents (PDF, Word, Excel, PowerPoint) or co-author documentation.

    Use this tool when the user's request involves creating, reading, editing,
    merging, converting, or otherwise manipulating document files, OR when they
    want help co-authoring structured documentation like specs, proposals, or RFCs.

    This tool delegates to a specialized sub-agent with deep knowledge of the
    target document format.

    Args:
        task: What to do, e.g. "merge a.pdf and b.pdf", "create an Excel report with monthly sales data", "draft a technical spec for the new auth system".
        skill: Which document skill to use. Set to "auto" (default) to auto-detect from the task, or specify one of: pdf, xlsx, pptx, docx, doc-coauthoring.
    """
    # --- Resolve skill ---
    if skill == "auto":
        detected = _detect_skill(task)
        if detected is None:
            return (
                "无法自动识别文档类型。请明确指定 skill 参数为以下之一: "
                "pdf, xlsx, pptx, docx, doc-coauthoring。\n"
                f"或者在任务描述中包含文件扩展名（如 .pdf, .docx）。"
            )
        skill = detected

    if skill not in _DOC_SKILLS:
        return f"不支持的 skill: {skill}。支持的选项: {', '.join(sorted(_DOC_SKILLS))}"

    # --- Load skill template ---
    template = _load_doc_skill(skill)
    if template is None:
        return f"未找到 skill '{skill}' 的模板文件。请确认 skills/{skill}.md 存在。"

    logger.info("process_document: using skill '%s' for task: %s", skill, task[:80])

    # --- Spawn sub-agent ---
    model = create_model()
    sub_agent = Agent(
        model=model,
        system_prompt=template,
        tools=[],
    )

    try:
        result = await sub_agent.invoke_async(task)
    except Exception as exc:
        logger.exception("Sub-agent for skill '%s' failed", skill)
        return f"文档处理失败: {exc}"

    # Extract text from the result
    content_blocks = result.message.get("content", [])
    texts = [b.get("text", "") for b in content_blocks if "text" in b]
    return "\n".join(texts) if texts else str(result.message)
