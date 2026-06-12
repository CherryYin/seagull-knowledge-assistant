"""merge 9d1e2 and wiki mining heads

Revision ID: f9c0d1e2f3a4
Revises: 9d1e2f3a4b5c, f8b9c0d1e2f3
Create Date: 2026-06-12 00:30:00.000000

"""
from typing import Sequence, Union


revision: str = "f9c0d1e2f3a4"
down_revision: Union[str, tuple[str, str], None] = ("9d1e2f3a4b5c", "f8b9c0d1e2f3")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
