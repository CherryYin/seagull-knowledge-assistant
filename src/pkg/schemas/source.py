from datetime import datetime

from pydantic import BaseModel, Field


class SourceCreate(BaseModel):
    """Create an external evidence record kept with provenance.

    Sources are imported or captured materials from outside the user, such as
    web pages, PDFs, RSS articles, repositories, and documents.
    """

    id: str | None = None
    title: str
    category_id: int = 1
    source_type: str = Field(pattern=r"^(pdf|article|conversation|image|video|web|github|code)$")
    url: str | None = None
    description: str | None = Field(default=None, max_length=8000)
    raw_content: str | None = None
    file_path: str | None = None
    metadata: dict | None = None


class SourceUpdate(BaseModel):
    """Partial update for an external evidence record."""

    title: str | None = None
    category_id: int | None = None
    source_type: str | None = Field(
        default=None,
        pattern=r"^(pdf|article|conversation|image|video|web|github|code)$",
    )
    url: str | None = None
    description: str | None = Field(default=None, max_length=8000)
    metadata: dict | None = None


class SourceRead(BaseModel):
    """External evidence returned to clients."""

    model_config = {"from_attributes": True}

    id: str
    title: str
    category_id: int
    category_name: str | None = None
    source_type: str
    url: str | None = None
    content_hash: str | None = None
    description: str | None = None
    raw_content: str | None = None
    file_path: str | None = None
    ingested_at: datetime
    metadata_: dict | None = Field(None, alias="metadata_")


class SourceList(BaseModel):
    items: list[SourceRead]
    total: int


class SourceUploadResult(SourceRead):
    created: bool
    duplicate: bool


class SourceDescriptionProposal(BaseModel):
    description: str
    model: str
    basis_content_hash: str | None = None
    generated_at: datetime


class SourceFileAccess(BaseModel):
    url: str
    expires_in_seconds: int | None = None


class ChunkRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    source_id: str
    chunk_index: int
    content: str
