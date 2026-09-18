from datetime import datetime
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator


USER_MEMORY_TYPE_PATTERN = r"^(profile|preference|activity_profile|production_memory)$"


# --- Auth ---

class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RegisterRequest(BaseModel):
    username: str
    display_name: str
    email: str | None = None
    password: str


class RegisterResponse(BaseModel):
    detail: str
    approval_status: str


# --- User CRUD ---

class UserCreate(BaseModel):
    username: str
    display_name: str
    email: str | None = None
    password: str
    role: str = "user"


class UserRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    username: str
    display_name: str
    email: str | None = None
    role: str
    approval_status: str
    is_active: bool
    created_at: datetime


class UserUpdate(BaseModel):
    display_name: str | None = None
    email: str | None = None
    role: str | None = None
    approval_status: str | None = None
    is_active: bool | None = None


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


# --- User Memory ---

class MemoryRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    memory_type: str = Field(pattern=USER_MEMORY_TYPE_PATTERN)
    key: str
    value: dict
    updated_at: datetime


class MemoryWrite(BaseModel):
    memory_type: str = Field(default="profile", pattern=USER_MEMORY_TYPE_PATTERN)
    value: dict


# --- User Settings ---

class SettingsRead(BaseModel):
    model_config = {"from_attributes": True}

    settings: dict
    updated_at: datetime


class SettingsUpdate(BaseModel):
    settings: dict


class PublishingSettingsRead(BaseModel):
    primary_site_url: str = ""
    default_channel: str = ""
    updated_at: datetime


class PublishingSettingsUpdate(BaseModel):
    primary_site_url: str | None = None
    default_channel: str | None = None

    @field_validator("primary_site_url")
    @classmethod
    def validate_primary_site_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().rstrip("/")
        if not normalized:
            return ""
        parsed = urlsplit(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("primary_site_url must be a complete HTTP or HTTPS URL")
        return normalized

    @field_validator("default_channel")
    @classmethod
    def normalize_default_channel(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


# --- Activity Log ---

class ActivityRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    action: str
    detail: dict | None = None
    created_at: datetime
