"""merge calendar recurrence and user api heads

Revision ID: f3c4d5e6f7a8
Revises: f2b3c4d5e6f7, fe4f5a6b7c8d
Create Date: 2026-07-14 00:00:00.000000

"""
from typing import Sequence, Union

revision: str = "f3c4d5e6f7a8"
down_revision: Union[str, tuple[str, str], None] = ("f2b3c4d5e6f7", "fe4f5a6b7c8d")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
