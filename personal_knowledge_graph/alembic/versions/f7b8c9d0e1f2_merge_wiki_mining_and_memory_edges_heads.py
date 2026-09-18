"""merge wiki mining and memory edges heads

Revision ID: f7b8c9d0e1f2
Revises: f6a7b8c9d0e1, f6b7c8d9e0f1
Create Date: 2026-06-12 00:10:00.000000

"""
from typing import Sequence, Union


revision: str = "f7b8c9d0e1f2"
down_revision: Union[str, tuple[str, str], None] = ("f6a7b8c9d0e1", "f6b7c8d9e0f1")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
