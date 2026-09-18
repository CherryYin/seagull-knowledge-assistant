import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from pkg.api.deps import get_current_user
from pkg.models.user import User
from pkg.schemas.completion import CompleteRequest
from pkg.services.cross_cutting.llm import create_async_client

logger = logging.getLogger(__name__)

router = APIRouter()


def _sse(event_type: str, data: dict | str) -> str:
    payload = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
    return f"event: {event_type}\ndata: {payload}\n\n"


@router.post("/action/complete")
async def complete_stream(body: CompleteRequest, request: Request, user: User = Depends(get_current_user)):
    """Stream a direct LLM completion without Agent tools or Session persistence."""
    client, resolved_model_id = create_async_client(
        model_id=body.model_id, provider_id=body.provider_id
    )

    async def event_generator():
        try:
            kwargs: dict[str, Any] = {"model": resolved_model_id, "messages": body.messages}
            if body.temperature is not None:
                kwargs["temperature"] = body.temperature
            response = await client.chat.completions.create(stream=True, **kwargs)

            if hasattr(response, "__aiter__"):
                async for chunk in response:
                    if await request.is_disconnected():
                        break
                    choices = getattr(chunk, "choices", None) or []
                    if not choices:
                        continue
                    delta = getattr(choices[0], "delta", None)
                    text = getattr(delta, "content", None) if delta is not None else None
                    if text:
                        yield _sse("content", {"text": text})
            else:
                choices = getattr(response, "choices", None) or []
                if choices:
                    message = getattr(choices[0], "message", None)
                    text = getattr(message, "content", None) if message is not None else None
                    if text:
                        yield _sse("content", {"text": text})

            yield _sse("done", {})
        except Exception as exc:
            logger.exception("complete stream failed")
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
