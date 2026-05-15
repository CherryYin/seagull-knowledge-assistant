from datetime import datetime

from pydantic import BaseModel, Field


class AgentProfileCreate(BaseModel):
    name: str = Field(max_length=100)
    agent_type: str = Field(default="action", pattern=r"^(action|story)$")
    description: str = ""
    system_prompt_append: str = ""
    model_id: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    enabled_tools: list[str] | None = None
    enabled_skills: list[str] | None = None
    is_default: bool = False


class AgentProfileRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    agent_type: str
    name: str
    description: str
    system_prompt_append: str
    model_id: str | None
    temperature: float | None
    enabled_tools: list[str] | None
    enabled_skills: list[str] | None
    is_default: bool
    created_at: datetime
    updated_at: datetime


class AgentProfileUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    agent_type: str | None = Field(default=None, pattern=r"^(action|story)$")
    description: str | None = None
    system_prompt_append: str | None = None
    model_id: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    enabled_tools: list[str] | None = None
    enabled_skills: list[str] | None = None
    is_default: bool | None = None


class AgentProfileList(BaseModel):
    items: list[AgentProfileRead]
    total: int
