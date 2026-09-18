from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


class TestCompleteStream:
    @staticmethod
    def _streaming_client():
        async def _create(*, model, messages, stream, **kwargs):
            async def _gen():
                for text in ("Hello", ", ", "world!"):
                    yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])

            return _gen()

        client = MagicMock()
        client.chat.completions.create = _create
        return client

    def test_streams_content_and_done(self, client):
        from pkg.api import completion as completion_module

        fake_client = self._streaming_client()
        with patch.object(completion_module, "create_async_client", return_value=(fake_client, "test-model")):
            with client.stream("POST", "/action/complete", json={"messages": [{"role": "user", "content": "hi"}]}) as response:
                assert response.status_code == 200
                body = "\n".join(response.iter_lines())
        assert "event: content" in body
        assert "Hello" in body
        assert "world!" in body
        assert "event: done" in body

    def test_non_streaming_fallback(self, client):
        from pkg.api import completion as completion_module

        def _create(*, model, messages, stream, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="full reply"))])

        client_obj = MagicMock()
        client_obj.chat.completions.create = _create
        with patch.object(completion_module, "create_async_client", return_value=(client_obj, "mm-model")):
            with client.stream("POST", "/action/complete", json={"messages": [{"role": "user", "content": "hi"}]}) as response:
                assert response.status_code == 200
                body = "\n".join(response.iter_lines())
        assert "full reply" in body
        assert "event: done" in body

    def test_error_emits_error_event(self, client):
        from pkg.api import completion as completion_module

        def _create(*, model, messages, stream, **kwargs):
            raise RuntimeError("boom")

        client_obj = MagicMock()
        client_obj.chat.completions.create = _create
        with patch.object(completion_module, "create_async_client", return_value=(client_obj, "x-model")):
            with client.stream("POST", "/action/complete", json={"messages": [{"role": "user", "content": "hi"}]}) as response:
                assert response.status_code == 200
                body = "\n".join(response.iter_lines())
        assert "event: error" in body
        assert "boom" in body


class TestLegacyAgentRoutesRemoved:
    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("post", "/action"),
            ("post", "/action/stream"),
            ("get", "/agent-profiles"),
            ("get", "/agent-runs"),
        ],
    )
    def test_legacy_agent_route_is_not_registered(self, client, method, path):
        response = getattr(client, method)(path, json={}) if method == "post" else getattr(client, method)(path)
        assert response.status_code == 404
