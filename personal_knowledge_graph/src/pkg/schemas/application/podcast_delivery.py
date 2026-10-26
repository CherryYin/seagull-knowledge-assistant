import re
from datetime import date, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, HttpUrl, model_validator


class PublicationMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: int = Field(strict=True, ge=0, le=9007199254740991)
    unit: Literal["people", "times"]
    source_field: Literal["read_num", "read_uv", "like_num", "old_like_num", "share_num", "share_uv", "comment_num", "collect_num", "favorite_num"] | None = None


class PublicationStatisticsSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: UUID
    source: Literal["manual_backend", "browser_report"]
    account_label: str = Field(min_length=1, max_length=80)
    period_kind: Literal["cumulative", "range"]
    period_start: date
    period_end: date
    captured_at: AwareDatetime
    metrics: dict[Literal["read", "like", "look", "share", "comment", "collect"], PublicationMetric] = Field(min_length=1, max_length=6)
    notes: str = Field(default="", max_length=2000)
    user_confirmed: Literal[True]

    @model_validator(mode="after")
    def validate_statistics(self):
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        if not self.period_start <= self.period_end <= self.captured_at.astimezone(now.tzinfo).date():
            raise ValueError("统计起止日期必须有效，且不能晚于采集日期")
        if self.captured_at > now:
            raise ValueError("采集时间不能在未来")
        for metric in self.metrics.values():
            if (self.source == "browser_report") != (metric.source_field is not None):
                raise ValueError("浏览器报告需逐项标明原始字段；手工录入不能伪装成报告字段")
        fields = [metric.source_field for metric in self.metrics.values() if metric.source_field]
        if len(fields) != len(set(fields)):
            raise ValueError("同一报告字段不能重复映射到不同指标")
        return self


class PodcastDeliveryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    base_revision: int = Field(ge=0)
    render_id: str = Field(min_length=1, max_length=200)
    channel: str = Field(default="微信公众号", min_length=1, max_length=100)
    publish_url: HttpUrl | None = None
    published_at: AwareDatetime | None = None
    confirm_published: bool = False
    notes: str = Field(default="", max_length=4000)
    adoption: Literal["undecided", "original", "modified", "not_used"] = "undecided"
    manual_steps: list[Literal["script", "pronunciation", "speed", "editing", "upload", "other"]] = Field(default_factory=list, max_length=6)
    feedback: str = Field(default="", max_length=4000)
    statistics_snapshots: list[PublicationStatisticsSnapshot] | None = Field(default=None, max_length=30)

    @model_validator(mode="after")
    def validate_publication(self):
        if self.confirm_published and self.published_at is None:
            raise ValueError("Confirming publication requires its actual timestamp")
        if self.published_at and self.published_at > datetime.now(self.published_at.tzinfo):
            raise ValueError("Publication time cannot be in the future")
        if self.publish_url and (self.publish_url.username or self.publish_url.password):
            raise ValueError("Publication URLs cannot contain credentials")
        if self.statistics_snapshots:
            if not self.confirm_published or not self.published_at or not self.publish_url:
                raise ValueError("效果快照需先确认已发布，并填写文章链接和发布时间")
            if self.publish_url.scheme != "https" or self.publish_url.host != "mp.weixin.qq.com" or not (self.publish_url.path == "/s" or re.fullmatch(r"/s/[A-Za-z0-9_-]{1,200}", self.publish_url.path)):
                raise ValueError("公众号效果快照只能绑定微信公众号文章")
            identifiers = [snapshot.id for snapshot in self.statistics_snapshots]
            if len(identifiers) != len(set(identifiers)):
                raise ValueError("效果快照标识不能重复")
            publication_date = self.published_at.astimezone(ZoneInfo("Asia/Shanghai")).date()
            for snapshot in self.statistics_snapshots:
                if snapshot.captured_at < self.published_at:
                    raise ValueError("采集时间不能早于发布时间")
                if snapshot.period_start < publication_date:
                    raise ValueError("统计区间不能早于文章发布日")
                if snapshot.period_kind == "cumulative" and snapshot.period_start != publication_date:
                    raise ValueError("累计统计需以文章发布日为起点")
        self.manual_steps = list(dict.fromkeys(self.manual_steps))
        return self


class PodcastDeliveryRead(PodcastDeliveryUpdate):
    statistics_snapshots: list[PublicationStatisticsSnapshot] = Field(default_factory=list, max_length=30)
    id: str
    revision: int
    script_approval_id: str
    file_sha256: str
    created_at: AwareDatetime
    updated_at: AwareDatetime
    recorded_by: str


class PodcastDeliveryList(BaseModel):
    items: list[PodcastDeliveryRead]
