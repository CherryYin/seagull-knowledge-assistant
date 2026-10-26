from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from pkg.services.application import podcast_policy


@pytest.mark.parametrize("age,expected", [(-1, False), (0, True), (7, True), (8, False)])
def test_pricing_policy_rejects_future_or_expired_verification(age, expected):
    checked_at = datetime.combine(
        podcast_policy.PRICE_CHECKED_ON, datetime.min.time(), tzinfo=timezone.utc
    )
    with patch.object(podcast_policy, "datetime") as clock:
        clock.now.return_value = checked_at + timedelta(days=age)
        assert podcast_policy.pricing_policy_current() is expected


@pytest.mark.parametrize(
    "enabled,current,ffmpeg,expected",
    [
        (False, True, "/usr/bin/ffmpeg", False),
        (True, False, "/usr/bin/ffmpeg", False),
        (True, True, None, False),
        (True, True, "/usr/bin/ffmpeg", True),
    ],
)
def test_execution_requires_opt_in_current_pricing_and_local_encoder(
    enabled, current, ffmpeg, expected
):
    with (
        patch.object(podcast_policy.settings, "PODCAST_AUDIO_ENABLED", enabled),
        patch.object(podcast_policy, "pricing_policy_current", return_value=current),
        patch.object(podcast_policy.shutil, "which", return_value=ffmpeg),
    ):
        assert podcast_policy.audio_execution_available() is expected
