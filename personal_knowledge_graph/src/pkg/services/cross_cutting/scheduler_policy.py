from dataclasses import dataclass
from typing import Literal


TaskCategory = Literal["maintenance", "memory", "collection", "derivation", "publication"]
TargetTrigger = Literal["calendar", "conditional_calendar", "due_items", "upstream_event"]
MigrationStatus = Literal["stable", "optional", "transitional"]


@dataclass(frozen=True, slots=True)
class ScheduledTaskPolicy:
    category: TaskCategory
    target_trigger: TargetTrigger
    migration_status: MigrationStatus
    target_independent_schedule: bool = False


SCHEDULED_TASK_POLICIES: dict[str, ScheduledTaskPolicy] = {
    "maintenance_cleanup": ScheduledTaskPolicy(
        category="maintenance",
        target_trigger="calendar",
        migration_status="stable",
        target_independent_schedule=True,
    ),
    "user_profiler": ScheduledTaskPolicy(
        category="memory",
        target_trigger="conditional_calendar",
        migration_status="stable",
        target_independent_schedule=True,
    ),
    "rss_fetch": ScheduledTaskPolicy(
        category="collection",
        target_trigger="due_items",
        migration_status="stable",
    ),
    "rss_summary": ScheduledTaskPolicy(
        category="derivation",
        target_trigger="upstream_event",
        migration_status="optional",
    ),
    "connector_trends": ScheduledTaskPolicy(
        category="collection",
        target_trigger="due_items",
        migration_status="stable",
    ),
    "discovery_generate": ScheduledTaskPolicy(
        category="derivation",
        target_trigger="upstream_event",
        migration_status="transitional",
    ),
    "web_directory_discover": ScheduledTaskPolicy(
        category="collection",
        target_trigger="due_items",
        migration_status="stable",
    ),
    "web_refresh": ScheduledTaskPolicy(
        category="collection",
        target_trigger="due_items",
        migration_status="stable",
    ),
    "paper_discovery": ScheduledTaskPolicy(
        category="collection",
        target_trigger="due_items",
        migration_status="stable",
    ),
    "news_auto_search": ScheduledTaskPolicy(
        category="collection",
        target_trigger="due_items",
        migration_status="transitional",
    ),
    "newsletter_automation": ScheduledTaskPolicy(
        category="publication",
        target_trigger="due_items",
        migration_status="stable",
    ),
}
