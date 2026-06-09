"""Web search tool powered by Tavily API."""

from strands import tool

from pkg.config import settings


@tool
async def web_search(query: str, max_results: int = 5) -> str:
    """Search the internet for up-to-date information.

    Use this tool when the user's question requires current information
    that is unlikely to be in the local knowledge base — such as recent
    news, live documentation, or facts you are unsure about.

    Args:
        query: Search query — be specific for better results.
        max_results: Number of results to return (1-10).
    """
    if not settings.TAVILY_API_KEY:
        return "错误：TAVILY_API_KEY 未配置。请在 .env 中设置 TAVILY_API_KEY。"

    from tavily import TavilyClient

    client = TavilyClient(api_key=settings.TAVILY_API_KEY)
    response = client.search(
        query=query,
        max_results=min(max_results, 10),
        include_answer=True,
    )

    lines: list[str] = []

    answer = response.get("answer")
    if answer:
        lines.append(f"**摘要**: {answer}\n")

    results = response.get("results", [])
    if not results:
        return "未找到相关搜索结果。"

    lines.append(f"找到 {len(results)} 条结果：\n")
    for i, r in enumerate(results, 1):
        lines.append(f"### {i}. {r.get('title', '无标题')}")
        lines.append(f"   URL: {r.get('url', '')}")
        content = r.get("content", "")
        if content:
            lines.append(f"   {content[:300]}")
        lines.append("")

    return "\n".join(lines)


@tool
async def find_skills(topic: str, max_results: int = 6) -> str:
    """Search the web for useful external skill ideas, templates, or examples.

    Use this when the user wants to discover good skills from outside sources
    before creating a local skill. This tool searches public web results for
    Claude/Codex-style skills, prompts, agents, workflows, and GitHub examples,
    then returns candidate links and guidance for adapting them safely.

    Args:
        topic: Skill topic or domain to search for, e.g. "meeting notes", "architecture diagrams", "research summarization".
        max_results: Number of candidate results to return (1-10).
    """
    if not settings.TAVILY_API_KEY:
        return "错误：TAVILY_API_KEY 未配置。请在 .env 中设置 TAVILY_API_KEY。"

    from tavily import TavilyClient

    query = (
        f'{topic} "SKILL.md" "description:" "Use this skill" '
        'site:github.com -issues -pull -discussions -releases'
    )
    client = TavilyClient(api_key=settings.TAVILY_API_KEY)
    response = client.search(
        query=query,
        max_results=min(max(max_results * 3, 10), 20),
        include_answer=False,
    )

    results = response.get("results", [])
    if not results:
        return "未找到真实 SKILL.md 页面。可以尝试换一个更具体的 topic。"

    noisy_parts = ("/issues/", "/pull/", "/discussions/", "/actions/", "/commit/", "/compare/", "/releases/", "/wiki/")
    skill_results = []
    rejected = 0
    for result in results:
        url = result.get("url", "")
        lower_url = url.lower()
        is_skill_page = (
            lower_url.endswith("skill.md")
            or "/blob/" in lower_url and lower_url.endswith("/skill.md")
            or "/tree/" in lower_url
        )
        if not is_skill_page or any(part in lower_url for part in noisy_parts):
            rejected += 1
            continue
        skill_results.append(result)
        if len(skill_results) >= max_results:
            break

    if not skill_results:
        return (
            "搜索到了相关页面，但没有找到可直接导入的真实 SKILL.md。\n"
            "已过滤 GitHub issue、PR、discussion、release 等非 skill 页面。"
        )

    lines = [f"找到 {len(skill_results)} 个与「{topic}」相关的真实 SKILL.md 候选：\n"]
    for i, result in enumerate(skill_results, 1):
        title = result.get("title", "无标题")
        url = result.get("url", "")
        content = result.get("content", "")
        lines.append(f"### {i}. {title}")
        lines.append(f"URL: {url}")
        if content:
            lines.append(f"摘要: {content[:450]}")
        lines.append("")

    lines.extend([
        "## 使用建议",
        "- 优先选择 URL 指向 SKILL.md 文件或 skill 目录的结果。",
        "- 不要安装 issue/PR/discussion 页面；这些已在搜索中尽量过滤。",
        "- 如果用户确认某个候选，可以调用 create_skill 创建本地 skill。",
        f"- 本次过滤掉 {rejected} 个非 skill 页面。",
    ])
    return "\n".join(lines)
