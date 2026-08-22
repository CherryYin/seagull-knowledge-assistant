from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from pkg.api.system import UserProviderReadiness, build_system_capabilities, get_system_capabilities


class _FakeProvider:
    def __init__(self, api_key: str = ""):
        self._api_key = api_key

    def resolve_api_key(self) -> str:
        return self._api_key


def _fake_settings(*, encryption_key: str = "enc-key", llm_key: str = "", news_key: str = "", openalex_key: str = "", semantic_scholar_key: str = "", arxiv_user_agent: str = "", wiki_concept_discovery_llm_enabled: bool = True):
    return SimpleNamespace(
        CREDENTIAL_ENCRYPTION_KEY=encryption_key,
        NEWSAPI_API_KEY=news_key,
        OPENALEX_API_KEY=openalex_key,
        SEMANTIC_SCHOLAR_API_KEY=semantic_scholar_key,
        ARXIV_USER_AGENT=arxiv_user_agent,
        WIKI_CONCEPT_DISCOVERY_LLM_ENABLED=wiki_concept_discovery_llm_enabled,
        get_llm_providers=lambda: [_FakeProvider(llm_key)],
    )


def test_build_system_capabilities_for_basic_user(fake_user):
    fake_settings = _fake_settings(llm_key="")
    with patch("pkg.api.system.settings", fake_settings):
        capabilities = build_system_capabilities(
            user=fake_user,
            user_providers={"newsapi": UserProviderReadiness(configured=False, storage_available=True)},
        )

    modules = capabilities.modules
    assert modules["api-keys"].status == "ready"
    assert modules["connectors"].status == "needs_setup"
    assert modules["connectors"].setup_route == "/settings/connectors"
    assert modules["agent-chat"].status == "needs_setup"
    assert modules["agent-chat"].setup_route == "/settings/agents"
    assert modules["wiki"].status == "experimental"
    assert modules["memory-tree"].experimental is True
    assert "admin-users" not in modules


def test_build_system_capabilities_for_admin_includes_admin_module(fake_admin):
    fake_settings = _fake_settings(llm_key="llm-key", news_key="news-key", arxiv_user_agent="arxiv-agent")
    with patch("pkg.api.system.settings", fake_settings):
        capabilities = build_system_capabilities(
            user=fake_admin,
            user_providers={"newsapi": UserProviderReadiness(configured=False, storage_available=True)},
        )

    modules = capabilities.modules
    assert modules["connectors"].status == "ready"
    assert modules["agent-chat"].status == "ready"
    assert modules["agent-profiles"].status == "ready"
    assert modules["admin-users"].status == "ready"


def test_build_system_capabilities_reports_api_key_storage_unavailable(fake_user):
    fake_settings = _fake_settings(llm_key="", wiki_concept_discovery_llm_enabled=False)
    with patch("pkg.api.system.settings", fake_settings):
        capabilities = build_system_capabilities(
            user=fake_user,
            user_providers={"newsapi": UserProviderReadiness(configured=False, storage_available=False)},
        )

    api_keys = capabilities.modules["api-keys"]
    assert api_keys.status == "needs_setup"
    assert "storage is unavailable" in (api_keys.detail or "")


@pytest.mark.asyncio
async def test_get_system_capabilities_uses_user_provider_readiness(fake_user, mock_session):
    fake_settings = _fake_settings(llm_key="")
    with patch("pkg.api.system.get_default_user_api_credential_secret", new=AsyncMock(return_value=("user-news-key", {}))), \
         patch("pkg.api.system.settings", fake_settings):
        capabilities = await get_system_capabilities(user=fake_user, session=mock_session)

    assert capabilities.modules["connectors"].status == "ready"
    assert capabilities.modules["api-keys"].status == "ready"
