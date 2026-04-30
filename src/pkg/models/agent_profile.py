import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


def _generate_profile_id() -> str:
    return f"profile-{uuid.uuid4()}"


class AgentProfile(Base):
    __tablename__ = "agent_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_generate_profile_id)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    system_prompt_append: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    model_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    enabled_tools: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    enabled_skills: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_agent_profiles_user_id", "user_id"),
        UniqueConstraint("user_id", "name", name="uq_agent_profiles_user_name"),
    )
