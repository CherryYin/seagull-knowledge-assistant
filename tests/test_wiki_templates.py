from pkg.services.foundation.wiki_templates import build_wiki_template, get_wiki_template


def test_build_topic_template():
    content = build_wiki_template("Personal Knowledge Graph", "topic")
    assert content.startswith("# Personal Knowledge Graph")
    assert "## Overview" in content
    assert "## Key Ideas" in content


def test_get_comparison_template():
    template = get_wiki_template("comparison")
    assert template["title"] == "Comparison"
    assert "Differences and Tradeoffs" in template["content"]
    assert "Where Each Option Fits" in template["content"]
