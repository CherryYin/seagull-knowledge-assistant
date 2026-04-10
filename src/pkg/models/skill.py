from datetime import datetime

from sqlalchemy import String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from pkg.db import Base


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # "skill-{name}"
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, server_default="")
    args: Mapped[list] = mapped_column(JSONB, server_default="[]")
    template: Mapped[str] = mapped_column(Text, nullable=False)
    tools_file: Mapped[str | None] = mapped_column(String(200))
    file_path: Mapped[str | None] = mapped_column(Text)  # OSS URI
    content_hash: Mapped[str] = mapped_column(String(64), server_default="")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
