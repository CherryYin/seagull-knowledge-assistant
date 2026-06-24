from datetime import datetime

from pydantic import BaseModel, Field


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


# --- Activity Log ---

class ActivityRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    action: str
    detail: dict | None = None
    created_at: datetime
