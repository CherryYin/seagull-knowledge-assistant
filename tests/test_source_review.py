from pkg.services.foundation.source_review import mark_explicitly_saved, merge_import_metadata


def test_merge_import_metadata_preserves_reviewed_terminal_state():
    merged = merge_import_metadata(
        {
            "review_status": "reviewed_kept",
            "reviewed_at": "2026-09-01T10:00:00+00:00",
            "kept_at": "2026-09-01T09:00:00+00:00",
        },
        {
            "review_status": "imported_reviewable",
            "reviewed_at": "2026-09-15T10:00:00+00:00",
            "kept_at": "2026-09-15T10:00:00+00:00",
            "fetch_status": "refreshed",
        },
    )

    assert merged["review_status"] == "reviewed_kept"
    assert merged["reviewed_at"] == "2026-09-01T10:00:00+00:00"
    assert merged["kept_at"] == "2026-09-01T09:00:00+00:00"
    assert merged["fetch_status"] == "refreshed"


def test_mark_explicitly_saved_creates_terminal_review_metadata():
    metadata = mark_explicitly_saved({"origin": "web_search"}, saved_at="2026-09-15T10:00:00+00:00")

    assert metadata["review_status"] == "reviewed_kept"
    assert metadata["reviewed_at"] == "2026-09-15T10:00:00+00:00"
    assert metadata["kept_at"] == "2026-09-15T10:00:00+00:00"
    assert metadata["retention"] == "permanent"
