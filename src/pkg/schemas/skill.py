from datetime import datetime

from pydantic import BaseModel


class SkillArgSchema(BaseModel):
    name: str
    description: str = ""
    required: bool = False


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    args: list[SkillArgSchema] = []
    template: str
    tools_file: str | None = None


class SkillRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    name: str
    description: str
    args: list[SkillArgSchema]
    template: str
    tools_file: str | None
    file_path: str | None
    source: str = "db"  # "local" or "db"
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SkillList(BaseModel):
    items: list[SkillRead]
    total: int


class SkillUpdate(BaseModel):
    description: str | None = None
    args: list[SkillArgSchema] | None = None
    template: str | None = None
    tools_file: str | None = None


class SkillFindRequest(BaseModel):
    topic: str
    max_results: int = 6


class SkillFindResponse(BaseModel):
    result: str
    candidates: list[SkillCreate] = []
