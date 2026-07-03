from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


SUPPORTED_CREDENTIAL_PROVIDER_PATTERN = r"^(qwen|minimax|azure_openai|embedding|tavily|newsapi|openalex|semantic_scholar|github|arxiv)$"


class UserApiCredentialCreate(BaseModel):
    provider: str = Field(pattern=SUPPORTED_CREDENTIAL_PROVIDER_PATTERN)
    label: str = Field(default="default", min_length=1, max_length=100)
    secret: str = Field(min_length=1)
    config: dict[str, Any] = Field(default_factory=dict)
    is_enabled: bool = True
    is_default: bool = False


class UserApiCredentialUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=100)
    secret: str | None = Field(default=None, min_length=1)
    config: dict[str, Any] | None = None
    is_enabled: bool | None = None
    is_default: bool | None = None


class UserApiCredentialRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    user_id: str
    provider: str
    label: str
    secret_masked: str
    config: dict[str, Any]
    is_enabled: bool
    is_default: bool
    created_at: datetime
    updated_at: datetime


class UserApiCredentialList(BaseModel):
    items: list[UserApiCredentialRead]
    total: int
