"""merge paper discovery and system jobs heads

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6, fa4b5c6d7e8f
Create Date: 2026-06-04 01:00:00.000000

"""
from typing import Sequence, Union

revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, tuple[str, str], None] = ("b1c2d3e4f5a6", "fa4b5c6d7e8f")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
