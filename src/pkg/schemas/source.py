from datetime import datetime

from pydantic import BaseModel, Field


class SourceCreate(BaseModel):
    id: str | None = None
    title: str
    source_type: str = Field(pattern=r"^(pdf|article|conversation|video|web|code)$")
    url: str | None = None
    raw_content: str | None = None
    file_path: str | None = None
    metadata: dict | None = None


class SourceRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    source_type: str
    url: str | None = None
    content_hash: str | None = None
    raw_content: str | None = None
    file_path: str | None = None
    ingested_at: datetime
    metadata_: dict | None = Field(None, alias="metadata_")


class SourceList(BaseModel):
    items: list[SourceRead]
    total: int
