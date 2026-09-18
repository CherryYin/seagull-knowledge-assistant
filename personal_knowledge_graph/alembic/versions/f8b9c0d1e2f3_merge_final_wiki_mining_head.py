"""merge final wiki mining head

Revision ID: f8b9c0d1e2f3
Revises: fc2d3e4f5a6b, f7b8c9d0e1f2
Create Date: 2026-06-12 00:20:00.000000

"""
from typing import Sequence, Union


revision: str = "f8b9c0d1e2f3"
down_revision: Union[str, tuple[str, str], None] = ("fc2d3e4f5a6b", "f7b8c9d0e1f2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
