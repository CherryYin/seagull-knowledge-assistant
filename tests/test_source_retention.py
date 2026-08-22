from pkg.services.foundation.source_retention import (
    apply_source_retention,
    is_auto_cleanup_protected,
)


def test_pdf_and_article_sources_are_always_permanent():
    assert apply_source_retention("pdf", None) == {"retention": "permanent"}
    assert apply_source_retention("article", {"retention": "temporary", "origin": "upload"}) == {
        "retention": "permanent",
        "origin": "upload",
    }
    assert is_auto_cleanup_protected("pdf") is True
    assert is_auto_cleanup_protected("article") is True


def test_other_source_types_keep_existing_retention_behavior():
    metadata = {"retention": "temporary"}
    assert apply_source_retention("web", metadata) is metadata
    assert is_auto_cleanup_protected("web") is False
