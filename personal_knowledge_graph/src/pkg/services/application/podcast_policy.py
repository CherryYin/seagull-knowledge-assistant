import shutil
from datetime import datetime, timezone, date
from decimal import Decimal

from pkg.config import settings


PRICE_POLICY_ID = "qwen3-tts-flash-cn-2026-10-16-v1"
PRICE_CHECKED_ON = date(2026, 10, 16)
MINIMUM_PRICE = Decimal("0.8")
SEGMENT_UTF16_LIMIT = 300
SEGMENTATION_VERSION = "utf16-300-double-reserve-v3"


def pricing_policy_current() -> bool:
    age = (datetime.now(timezone.utc).date() - PRICE_CHECKED_ON).days
    return 0 <= age <= 7


def audio_execution_available() -> bool:
    return bool(
        settings.PODCAST_AUDIO_ENABLED and pricing_policy_current() and shutil.which("ffmpeg")
    )
