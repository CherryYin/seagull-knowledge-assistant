from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


AssetFeatureState = Literal[
    "completed", "blocked", "needs_review", "in_progress", "not_started", "unknown", "failed"
]


class AssetFeatureCounts(BaseModel):
    feature: str
    label: str
    optional: bool = False
    completed: int = 0
    blocked: int = 0
    needs_review: int = 0
    in_progress: int = 0
    not_started: int = 0
    unknown: int = 0
    failed: int = 0
    recorded_failure_assets: int | None = None
    reasons: dict[str, int] = Field(default_factory=dict)


class AssetFeatureIssue(BaseModel):
    asset_id: str
    title: str
    asset_type: str
    asset_status: str
    feature: str
    state: AssetFeatureState
    reason: str
    block_ids: list[str] = Field(default_factory=list)


class AssetVisualMetrics(BaseModel):
    total_tasks: int = 0
    failed_tasks: int = 0
    active_tasks: int = 0
    processing_attempts: int = 0
    retry_attempts: int = 0
    timed_tasks: int = 0
    mean_elapsed_seconds: float | None = None


class AssetAnalytics(BaseModel):
    generated_at: datetime
    total_assets: int
    assets_with_attention: int
    assets_without_workspace: int
    by_type: dict[str, int]
    by_status: dict[str, int]
    features: list[AssetFeatureCounts]
    visual_metrics: AssetVisualMetrics
    issues: list[AssetFeatureIssue]
    issue_total: int
    issue_offset: int
    issue_limit: int
    measurement_limits: list[str]
