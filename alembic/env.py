import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.config import settings
from pkg.db import Base
from pkg.models.category import Category  # noqa: F401
from pkg.models.source import Source, SourceChunk, SourceEmbedding  # noqa: F401
from pkg.models.note import Note, NoteEmbedding  # noqa: F401
from pkg.models.chat_session import ChatSession  # noqa: F401
from pkg.models.skill import Skill  # noqa: F401
from pkg.models.user import User, UserMemory, UserSettings, ActivityLog  # noqa: F401
from pkg.models.stats import KnowledgeStats  # noqa: F401
from pkg.models.agent_profile import AgentProfile  # noqa: F401

config = context.config
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL_SYNC)
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
