from pkg.models.chat_session import ChatSession, ChatSessionEvent


def test_chat_session_contains_harness_persistence_columns():
    columns = ChatSession.__table__.columns

    assert columns.harness_format_version.nullable is True
    assert str(columns.persistence_revision.server_default.arg) == "0"
    assert str(columns.next_event_seq.server_default.arg) == "0"
    assert str(columns.projection_seq.server_default.arg) == "-1"
    assert columns.materialized_at.nullable is True


def test_chat_session_event_uses_session_and_seq_primary_key():
    primary_key = [column.name for column in ChatSessionEvent.__table__.primary_key.columns]

    assert primary_key == ["session_id", "seq"]
    assert ChatSessionEvent.__table__.columns.data.nullable is False
    assert ChatSessionEvent.__table__.columns.ignorable.nullable is True
