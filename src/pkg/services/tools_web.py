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
