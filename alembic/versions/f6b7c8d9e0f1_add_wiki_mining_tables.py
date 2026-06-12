"""add wiki mining tables

Revision ID: f6b7c8d9e0f1
Revises: f5a6b7c8d9e0
Create Date: 2026-06-12 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f6b7c8d9e0f1"
down_revision: Union[str, None] = "f5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wiki_mining_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="completed", nullable=False),
        sa.Column("window_start", sa.DateTime(), nullable=True),
        sa.Column("window_end", sa.DateTime(), nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wiki_mining_runs_user_id", "wiki_mining_runs", ["user_id"])
    op.create_index("idx_wiki_mining_runs_status", "wiki_mining_runs", ["status"])
    op.create_index("idx_wiki_mining_runs_created_at", "wiki_mining_runs", ["created_at"])

    op.create_table(
        "wiki_insight_candidates",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("insight_type", sa.String(length=30), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("evidence_refs", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("status", sa.String(length=30), server_default="pending", nullable=False),
        sa.Column("reviewer_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["wiki_mining_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wiki_insight_candidates_run_id", "wiki_insight_candidates", ["run_id"])
    op.create_index("idx_wiki_insight_candidates_user_id", "wiki_insight_candidates", ["user_id"])
    op.create_index("idx_wiki_insight_candidates_status", "wiki_insight_candidates", ["status"])

    op.create_table(
        "wiki_article_drafts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("page_type", sa.String(length=50), server_default="topic", nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("evidence_refs", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("status", sa.String(length=30), server_default="candidate", nullable=False),
        sa.Column("reviewer_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["wiki_mining_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wiki_article_drafts_run_id", "wiki_article_drafts", ["run_id"])
    op.create_index("idx_wiki_article_drafts_user_id", "wiki_article_drafts", ["user_id"])
    op.create_index("idx_wiki_article_drafts_status", "wiki_article_drafts", ["status"])


def downgrade() -> None:
    op.drop_index("idx_wiki_article_drafts_status", table_name="wiki_article_drafts")
    op.drop_index("idx_wiki_article_drafts_user_id", table_name="wiki_article_drafts")
    op.drop_index("idx_wiki_article_drafts_run_id", table_name="wiki_article_drafts")
    op.drop_table("wiki_article_drafts")

    op.drop_index("idx_wiki_insight_candidates_status", table_name="wiki_insight_candidates")
    op.drop_index("idx_wiki_insight_candidates_user_id", table_name="wiki_insight_candidates")
    op.drop_index("idx_wiki_insight_candidates_run_id", table_name="wiki_insight_candidates")
    op.drop_table("wiki_insight_candidates")

    op.drop_index("idx_wiki_mining_runs_created_at", table_name="wiki_mining_runs")
    op.drop_index("idx_wiki_mining_runs_status", table_name="wiki_mining_runs")
    op.drop_index("idx_wiki_mining_runs_user_id", table_name="wiki_mining_runs")
    op.drop_table("wiki_mining_runs")
