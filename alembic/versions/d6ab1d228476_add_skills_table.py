"""add skills table

Revision ID: d6ab1d228476
Revises: 4a98966f2faa
Create Date: 2026-04-09 18:24:22.837903

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'd6ab1d228476'
down_revision: Union[str, None] = '4a98966f2faa'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('skills',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('name', sa.String(length=64), nullable=False),
    sa.Column('description', sa.Text(), server_default='', nullable=False),
    sa.Column('args', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
    sa.Column('template', sa.Text(), nullable=False),
    sa.Column('tools_file', sa.String(length=200), nullable=True),
    sa.Column('file_path', sa.Text(), nullable=True),
    sa.Column('content_hash', sa.String(length=64), server_default='', nullable=False),
    sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )


def downgrade() -> None:
    op.drop_table('skills')
