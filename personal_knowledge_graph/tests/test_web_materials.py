from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from pkg.schemas.discovery import DiscoveryWebSaveRequest


def selected_result():
    return {
        "title": "Original story",
        "url": "https://example.com/story",
        "summary": "Search summary",
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ("url", "javascript:alert(1)"),
        ("url", "file:///tmp/story"),
        ("url", "https://user:password@example.com/story"),
        ("url", "not-a-url"),
        ("title", " "),
        ("title", "\x00"),
        ("summary", "x" * 10001),
        ("source_name", "x" * 201),
        ("published_at", "x" * 101),
        ("user_id", "foreign"),
        ("metadata", {"fact_check_status": "verified"}),
    ],
)
def test_web_material_request_rejects_unsafe_or_unbounded_fields(field, value):
    with pytest.raises(ValidationError):
        DiscoveryWebSaveRequest(query="topic", items=[{**selected_result(), field: value}])


@pytest.mark.parametrize(
    "changes",
    [
        {"query": " "},
        {"query": "x" * 501},
        {"query": "\x00"},
        {"items": []},
        {"items": [selected_result()] * 21},
        {"user_id": "foreign"},
    ],
)
def test_web_material_batch_is_explicit_and_bounded(changes):
    with pytest.raises(ValidationError):
        DiscoveryWebSaveRequest(**{"query": "topic", "items": [selected_result()], **changes})


def test_web_material_request_normalizes_links_without_lowercasing_paths():
    body = DiscoveryWebSaveRequest(
        query=" topic ",
        items=[
            {
                **selected_result(),
                "url": "https://EXAMPLE.com/Story#fragment",
                "title": " Story ",
            }
        ],
    )
    assert body.query == "topic"
    assert body.items[0].url == "https://example.com/Story"
    assert body.items[0].title == "Story"


def test_web_material_save_route_uses_current_user_and_never_searches(client, mock_session):
    body = {"query": "topic", "items": [selected_result()]}
    with (
        patch(
            "pkg.api.discovery.save_web_materials",
            new=AsyncMock(return_value={"items": [], "created": 0, "reused": 0}),
        ) as save,
        patch("pkg.api.discovery.search_external_web_results", new=AsyncMock()) as search,
    ):
        response = client.post("/discovery/web-results/save", json=body)
    assert response.status_code == 200
    assert save.call_args.args == (mock_session,)
    assert save.call_args.kwargs["user_id"] == "test-user-001"
    assert save.call_args.kwargs["body"].model_dump(exclude_none=True) == body
    search.assert_not_awaited()


def test_web_material_preview_is_read_only_and_passes_user_scope(client, mock_session):
    with (
        patch(
            "pkg.api.discovery.search_external_web_results",
            new=AsyncMock(return_value=[selected_result()]),
        ) as search,
        patch("pkg.api.discovery.save_web_materials", new=AsyncMock()) as save,
    ):
        response = client.post(
            "/discovery/web-search/preview", json={"query": "topic", "max_results": 8}
        )
    assert response.status_code == 200
    search.assert_awaited_once_with("topic", max_results=8, user_id="test-user-001")
    save.assert_not_awaited()
    mock_session.commit.assert_not_awaited()


@pytest.mark.parametrize("path", ["/discovery/web-results/save", "/discovery/web-search/preview"])
def test_web_material_routes_require_authentication(client, path):
    from pkg.api.app import app
    from pkg.api.deps import get_current_user

    override = app.dependency_overrides.pop(get_current_user)
    try:
        assert (
            client.post(path, json={"query": "topic", "items": [selected_result()]}).status_code
            == 401
        )
    finally:
        app.dependency_overrides[get_current_user] = override
