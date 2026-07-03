"""merge user api credentials and wiki heads

Revision ID: fe4f5a6b7c8d
Revises: f9c0d1e2f3a4, fd3e4f5a6b7c
Create Date: 2026-06-30 00:00:00.000000

"""
from typing import Sequence, Union


revision: str = "fe4f5a6b7c8d"
down_revision: Union[str, tuple[str, str], None] = ("f9c0d1e2f3a4", "fd3e4f5a6b7c")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
