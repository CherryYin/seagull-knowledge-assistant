from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.api.calendar_reminders import create_calendar_reminder, delete_calendar_reminder, update_calendar_reminder
from pkg.models.calendar_reminder import CalendarReminder
from pkg.models.foundation.note import Note
from pkg.schemas.calendar_reminder import CalendarReminderCreate, CalendarReminderRead, CalendarReminderUpdate


@pytest.mark.asyncio
async def test_create_calendar_reminder(mock_session, fake_user):
    mock_session.refresh = AsyncMock()
    result = await create_calendar_reminder(
        CalendarReminderCreate(date="2026-05-22", text=" Write roadmap "),
        user=fake_user,
        session=mock_session,
    )

    assert result.user_id == fake_user.id
    assert result.date == "2026-05-22"
    assert result.text == "Write roadmap"
    assert result.is_done is False
    mock_session.add.assert_called_once()
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_calendar_reminder_returns_linked_note(mock_session, fake_user):
    note = MagicMock(spec=Note)
    note.id = "note-1"
    note.user_id = fake_user.id
    note.title = "Roadmap context"
    note.status = "seed"
    mock_session.get.return_value = note

    async def refresh_reminder(reminder):
        reminder.id = "reminder-1"
        reminder.recurrence = reminder.recurrence or "once"
        reminder.created_at = datetime(2026, 9, 14, tzinfo=timezone.utc)
        reminder.updated_at = datetime(2026, 9, 14, tzinfo=timezone.utc)

    mock_session.refresh = AsyncMock(side_effect=refresh_reminder)

    result = await create_calendar_reminder(
        CalendarReminderCreate(date="2026-09-14", text="Review roadmap", note_id=note.id),
        user=fake_user,
        session=mock_session,
    )

    assert result.note_id == note.id
    assert result.linked_note is note
    assert CalendarReminderRead.model_validate(result).linked_note.title == note.title


@pytest.mark.asyncio
async def test_update_calendar_reminder_requires_owner(mock_session, fake_user):
    reminder = MagicMock(spec=CalendarReminder)
    reminder.user_id = "other-user"
    mock_session.get.return_value = reminder

    with pytest.raises(Exception):
        await update_calendar_reminder("reminder-1", CalendarReminderUpdate(is_done=True), user=fake_user, session=mock_session)


@pytest.mark.asyncio
async def test_update_calendar_reminder_marks_done(mock_session, fake_user):
    reminder = CalendarReminder(user_id=fake_user.id, date="2026-05-22", text="Task", is_done=False)
    reminder.id = "reminder-1"
    reminder.created_at = datetime(2026, 5, 22, tzinfo=timezone.utc)
    reminder.updated_at = datetime(2026, 5, 22, tzinfo=timezone.utc)
    mock_session.get.return_value = reminder

    result = await update_calendar_reminder("reminder-1", CalendarReminderUpdate(is_done=True), user=fake_user, session=mock_session)

    assert result.is_done is True
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_calendar_reminder_attaches_note(mock_session, fake_user):
    reminder = CalendarReminder(user_id=fake_user.id, date="2026-09-14", text="Task", recurrence="once", is_done=False)
    reminder.id = "reminder-1"
    reminder.created_at = datetime(2026, 9, 14, tzinfo=timezone.utc)
    reminder.updated_at = datetime(2026, 9, 14, tzinfo=timezone.utc)
    note = MagicMock(spec=Note)
    note.id = "note-1"
    note.user_id = fake_user.id
    note.title = "Task context"
    note.status = "seed"
    mock_session.get.side_effect = [reminder, note]

    result = await update_calendar_reminder(
        reminder.id,
        CalendarReminderUpdate(note_id=note.id),
        user=fake_user,
        session=mock_session,
    )

    assert result.note_id == note.id
    assert result.linked_note is note
    assert CalendarReminderRead.model_validate(result).linked_note.title == note.title
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_calendar_reminder(mock_session, fake_user):
    reminder = CalendarReminder(user_id=fake_user.id, date="2026-05-22", text="Task", is_done=False)
    reminder.id = "reminder-1"
    mock_session.get.return_value = reminder

    await delete_calendar_reminder("reminder-1", user=fake_user, session=mock_session)

    mock_session.delete.assert_awaited_once_with(reminder)
    mock_session.commit.assert_awaited_once()
