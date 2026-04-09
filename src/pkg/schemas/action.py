from pydantic import BaseModel


class ActionRequest(BaseModel):
    task: str
    conversation_history: list[dict[str, str]] = []


class ActionResponse(BaseModel):
    result: str
    stop_reason: str
