from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError


@pytest.mark.asyncio
async def test_publishing_settings_read_and_patch_preserve_other_settings(fake_user, mock_session):
    from pkg.api import auth as auth_api
    from pkg.schemas.user import PublishingSettingsUpdate

    updated_at = datetime(2026, 8, 25, tzinfo=timezone.utc)
    stored = SimpleNamespace(
        settings={
            "publishing": {"primary_site_url": "https://old.example.com", "default_channel": "Blog"},
            "modules": {"calendar": True},
        },
        updated_at=updated_at,
    )
    mock_session.get.return_value = stored

    current = await auth_api.get_publishing_settings(user=fake_user, session=mock_session)
    assert current.primary_site_url == "https://old.example.com"
    assert current.default_channel == "Blog"

    changed = await auth_api.update_publishing_settings(
        PublishingSettingsUpdate(primary_site_url="https://new.example.com/", default_channel=" Newsletter "),
        user=fake_user,
        session=mock_session,
    )

    assert changed.primary_site_url == "https://new.example.com"
    assert changed.default_channel == "Newsletter"
    assert stored.settings["modules"] == {"calendar": True}
    assert stored.settings["publishing"] == {
        "primary_site_url": "https://new.example.com",
        "default_channel": "Newsletter",
    }
    mock_session.commit.assert_awaited_once()


def test_publishing_settings_reject_invalid_primary_url():
    from pkg.schemas.user import PublishingSettingsUpdate

    with pytest.raises(ValidationError, match="complete HTTP or HTTPS URL"):
        PublishingSettingsUpdate(primary_site_url="example.com")
