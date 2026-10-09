import json

from pkg.config import Settings


def test_llm_provider_resolves_key_loaded_by_settings():
    settings = Settings(
        _env_file=None,
        MINIMAX_API_KEY="minimax-secret",
        LLM_PROVIDERS=json.dumps([
            {
                "id": "minimax",
                "display_name": "MiniMax",
                "base_url": "https://api.minimaxi.com/v1",
                "api_key_env": "MINIMAX_API_KEY",
                "default_model": "MiniMax-M3",
            }
        ]),
    )

    provider = settings.get_provider("minimax")

    assert provider is not None
    assert provider.base_url == "https://api.minimaxi.com/v1"
    assert provider.resolve_api_key() == "minimax-secret"
