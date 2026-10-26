from datetime import date, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

Count = Annotated[int, Field(strict=True, ge=0)]
Rate = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


def validate_publication_date(value: date) -> date:
    yesterday = datetime.now(ZoneInfo("Asia/Shanghai")).date() - timedelta(days=1)
    if not date(2025, 11, 1) <= value <= yesterday:
        raise ValueError("请选择 2025-11-01 至昨日之间的文章发表日期（北京时间）；今天的数据尚不可查询")
    return value


class WechatStatisticsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    credential_id: int = Field(gt=0)
    publication_date: date

    _valid_date = field_validator("publication_date")(validate_publication_date)


class WechatArticleMetrics(BaseModel):
    stat_date: date
    read_user: Count | None = None
    share_user: Count | None = None
    zaikan_user: Count | None = None
    like_user: Count | None = None
    comment_count: Count | None = None
    collection_user: Count | None = None
    read_subscribe_user: Count | None = None
    read_delivery_rate: Rate | None = None
    read_finish_rate: Rate | None = None
    read_avg_activetime: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class WechatArticleStatistics(BaseModel):
    ref_date: date
    msgid: str = Field(pattern=r"^\d{1,30}_\d{1,5}$")
    title: str = Field(default="", max_length=1000)
    content_url: HttpUrl | None = None
    detail_list: list[WechatArticleMetrics] = Field(max_length=30)

    @field_validator("content_url")
    @classmethod
    def validate_article_url(cls, value):
        if value and (value.host != "mp.weixin.qq.com" or value.username or value.password):
            raise ValueError("Unexpected article URL")
        return value

    @model_validator(mode="after")
    def validate_dates(self):
        dates = [item.stat_date for item in self.detail_list]
        yesterday = datetime.now(ZoneInfo("Asia/Shanghai")).date() - timedelta(days=1)
        if len(set(dates)) != len(dates) or any(not self.ref_date <= value <= min(self.ref_date + timedelta(days=29), yesterday) for value in dates):
            raise ValueError("Unexpected statistics dates")
        self.detail_list.sort(key=lambda item: item.stat_date)
        return self


class WechatStatisticsPayload(BaseModel):
    list: Annotated[list[WechatArticleStatistics], Field(max_length=100)]
    is_delay: bool | None = None


class WechatStatisticsRead(BaseModel):
    id: str
    credential_id: int
    publication_date: date
    fetched_at: datetime
    data: WechatStatisticsPayload


class WechatStatisticsSaved(BaseModel):
    snapshot: WechatStatisticsRead | None
