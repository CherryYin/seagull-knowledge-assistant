from pydantic import BaseModel


class CompleteMessage(BaseModel):
    role: str
    content: str


class CompleteRequest(BaseModel):
    """Lightweight direct LLM completion without tools or Session persistence."""

    messages: list[CompleteMessage]
    model_id: str | None = None
    provider_id: str | None = None
    temperature: float | None = None
