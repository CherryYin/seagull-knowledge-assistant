"""merge assets and existing head

Revision ID: fc2d3e4f5a6b
Revises: c2d3e4f5a6b7, fb1c2d3e4f5a
Create Date: 2026-06-08 00:00:00.000000

"""
from typing import Sequence, Union

revision: str = "fc2d3e4f5a6b"
down_revision: Union[str, tuple[str, str], None] = ("c2d3e4f5a6b7", "fb1c2d3e4f5a")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
