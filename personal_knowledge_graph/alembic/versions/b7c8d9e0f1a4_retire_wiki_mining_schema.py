"""retire wiki mining schema

Revision ID: b7c8d9e0f1a4
Revises: b7c8d9e0f1a3
Create Date: 2026-08-22
"""

from alembic import op


revision = "b7c8d9e0f1a4"
down_revision = "b7c8d9e0f1a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO categories (name, display_name, description)
        VALUES ('general', 'General', 'General knowledge notes')
        ON CONFLICT (name) DO NOTHING
        """
    )
    op.execute(
        """
        WITH unique_drafts AS (
            SELECT DISTINCT ON (
                user_id,
                COALESCE(metadata->>'target_wiki_id', ''),
                md5(content)
            ) *
            FROM wiki_article_drafts
            WHERE metadata->>'origin' = 'wiki_update_draft'
            ORDER BY
                user_id,
                COALESCE(metadata->>'target_wiki_id', ''),
                md5(content),
                id
        )
        INSERT INTO notes (
            id,
            user_id,
            category_id,
            title,
            note_type,
            domains,
            tags,
            abstract,
            content,
            status,
            confidence,
            source_ids,
            created_at,
            updated_at
        )
        SELECT
            'note-legacy-wiki-update-draft-' || draft.id,
            draft.user_id,
            category.id,
            '[Legacy Wiki Update Draft] ' || draft.title,
            'writing',
            ARRAY[]::text[],
            ARRAY['legacy-wiki-update-draft', 'from-wiki-update-draft']::text[],
            draft.summary,
            '# Archived Wiki Update Draft' || E'\n\n' ||
                'Target Wiki: `' || COALESCE(draft.metadata->>'target_wiki_id', 'unknown') || '`' ||
                E'\n\n' || draft.content,
            'seed',
            'medium',
            ARRAY[]::text[],
            draft.created_at,
            draft.updated_at
        FROM unique_drafts AS draft
        CROSS JOIN LATERAL (
            SELECT id FROM categories WHERE name = 'general' LIMIT 1
        ) AS category
        ON CONFLICT (id) DO NOTHING
        """
    )
    op.drop_table("wiki_article_drafts")
    op.drop_table("wiki_insight_candidates")
    op.drop_table("wiki_mining_runs")


def downgrade() -> None:
    raise RuntimeError("Wiki mining retirement is irreversible; restore from the SQL audit backup if needed")
