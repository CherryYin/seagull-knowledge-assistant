from pydantic import BaseModel


class ActionRequest(BaseModel):
    task: str
    session_id: str | None = None
    profile_id: str | None = None
    conversation_history: list[dict[str, str]] = []


class ActionResponse(BaseModel):
    result: str
    stop_reason: str
    session_id: str | None = None
