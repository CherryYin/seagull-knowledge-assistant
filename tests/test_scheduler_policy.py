from pkg.services.cross_cutting.scheduler import get_scheduled_tasks
from pkg.services.cross_cutting.scheduler_policy import SCHEDULED_TASK_POLICIES


def test_every_registered_task_has_an_explicit_policy():
    registered = {task.name for task in get_scheduled_tasks()}

    assert registered <= set(SCHEDULED_TASK_POLICIES)


def test_upstream_derivations_are_not_independent_scheduled_tasks():
    registered = {task.name for task in get_scheduled_tasks()}

    assert "rss_summary" not in registered
    assert "discovery_generate" not in registered


def test_only_calendar_maintenance_and_memory_remain_independent_schedules():
    independent = {
        name
        for name, policy in SCHEDULED_TASK_POLICIES.items()
        if policy.target_independent_schedule
    }

    assert independent == {"maintenance_cleanup", "user_profiler"}


def test_derivation_tasks_are_targeted_for_upstream_events():
    event_driven = {
        name
        for name, policy in SCHEDULED_TASK_POLICIES.items()
        if policy.target_trigger == "upstream_event"
    }

    assert event_driven == {"rss_summary", "discovery_generate"}


def test_global_search_jobs_are_explicitly_transitional():
    transitional = {
        name
        for name, policy in SCHEDULED_TASK_POLICIES.items()
        if policy.migration_status == "transitional"
    }

    assert transitional == {"discovery_generate", "news_auto_search"}


def test_connector_trends_scheduler_is_named_as_github_profile_collection():
    task = next(task for task in get_scheduled_tasks() if task.name == "connector_trends")

    assert task.job_type == "connector_trends"
    assert task.title == "GitHub trend profile collection"
    assert task.handler.__name__ == "run_connector_trends_step"
