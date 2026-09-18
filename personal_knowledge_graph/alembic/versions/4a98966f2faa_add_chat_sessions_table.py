"""add chat_sessions table

Revision ID: 4a98966f2faa
Revises: 001
Create Date: 2026-04-09 17:00:33.314054

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '4a98966f2faa'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('chat_sessions',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('title', sa.Text(), server_default='New Session', nullable=False),
    sa.Column('messages', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
    sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('idx_chat_sessions_updated', 'chat_sessions', ['updated_at'])


def downgrade() -> None:
    op.drop_index('idx_chat_sessions_updated', table_name='chat_sessions')
    op.drop_table('chat_sessions')
