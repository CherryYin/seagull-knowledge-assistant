from pathlib import Path


WEB_ROOT = Path(__file__).resolve().parents[1] / "web" / "src"

PRODUCT_FILES = [
    WEB_ROOT / "components" / "ChatMessage.tsx",
    WEB_ROOT / "pages" / "AssetDetailPage.tsx",
    WEB_ROOT / "pages" / "ReviewPage.tsx",
    WEB_ROOT / "pages" / "SearchPage.tsx",
    WEB_ROOT / "pages" / "SourceDetailPage.tsx",
    WEB_ROOT / "pages" / "SourcesPage.tsx",
    WEB_ROOT / "pages" / "UserProfilePage.tsx",
    WEB_ROOT / "pages" / "WikiRulesPage.tsx",
]

MODULE_CONFIG = WEB_ROOT / "config" / "modules.ts"

FORBIDDEN_PRODUCT_TERMS = [
    "Production Memory",
    "personal memory",
    "User Memory Layers",
    "knowledge tree",
    "generate memory",
    "Source/Note/Memory/Wiki",
]


def test_active_product_copy_uses_canonical_domain_terms():
    product_copy = "\n".join(path.read_text(encoding="utf-8") for path in PRODUCT_FILES)

    for forbidden_term in FORBIDDEN_PRODUCT_TERMS:
        assert forbidden_term not in product_copy

    assert "Profile Facts & Preferences" in product_copy
    assert "Inferred Profile Signals" in product_copy
    assert "Production History" in product_copy
    assert "Knowledge Record" in product_copy


def test_core_knowledge_lifecycle_is_always_visible_in_navigation():
    module_config = MODULE_CONFIG.read_text(encoding="utf-8")

    for module_id, label in [
        ("search", "Search"),
        ("sources", "Sources"),
        ("notes", "Notes"),
        ("wiki", "Wiki"),
        ("review", "Inbox"),
        ("assets", "Assets"),
    ]:
        marker = f'id: "{module_id}"'
        start = module_config.index(marker)
        end = module_config.index("\n  },", start)
        module_block = module_config[start:end]
        assert f'label: "{label}"' in module_block
        assert "nav: { primary: true" in module_block
        assert "visibility: { defaultEnabled: true, configurable: false }" in module_block
