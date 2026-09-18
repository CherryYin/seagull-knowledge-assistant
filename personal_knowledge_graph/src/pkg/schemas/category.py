from datetime import datetime

from pydantic import BaseModel, Field


class CategoryCreate(BaseModel):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$", max_length=100)
    display_name: str = Field(max_length=200)
    description: str | None = None


class CategoryRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    name: str
    display_name: str
    description: str | None = None
    created_at: datetime


class CategoryUpdate(BaseModel):
    display_name: str | None = Field(None, max_length=200)
    description: str | None = None


class CategoryList(BaseModel):
    items: list[CategoryRead]
    total: int
