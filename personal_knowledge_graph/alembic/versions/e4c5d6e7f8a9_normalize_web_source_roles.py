"""normalize web source roles and terminal decisions

Revision ID: e4c5d6e7f8a9
Revises: e3b4c5d6e7f8
Create Date: 2026-09-15

"""

from collections.abc import Sequence

from alembic import op


revision: str = "e4c5d6e7f8a9"
down_revision: str | None = "e3b4c5d6e7f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE sources
        SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{web_role}',
            to_jsonb(
                CASE
                    WHEN metadata ? 'feed_source_id' THEN 'article'
                    WHEN COALESCE(metadata->>'rss_enabled', '') = 'true' THEN 'collection_feed'
                    WHEN COALESCE(metadata->>'web_directory_enabled', '') = 'true'
                      OR COALESCE(metadata->>'web_directory', '') = 'true' THEN 'collection_directory'
                    ELSE 'page'
                END::text
            ),
            true
        )
        WHERE source_type = 'web'
        """
    )
    op.execute(
        """
        UPDATE sources
        SET metadata = jsonb_set(
            jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{collection_source_id}',
                to_jsonb(metadata->>'feed_source_id'),
                true
            ),
            '{origin}',
            to_jsonb(
                CASE
                    WHEN metadata->>'content_source' = 'web_directory' THEN 'web_directory'
                    ELSE 'rss'
                END::text
            ),
            true
        )
        WHERE source_type = 'web'
          AND metadata ? 'feed_source_id'
        """
    )
    op.execute(
        """
        UPDATE sources
        SET metadata = jsonb_set(
            jsonb_set(
                jsonb_set(
                    COALESCE(metadata, '{}'::jsonb),
                    '{review_status}',
                    '"reviewed_kept"'::jsonb,
                    true
                ),
                '{reviewed_at}',
                to_jsonb(COALESCE(metadata->>'reviewed_at', metadata->>'kept_at', CURRENT_TIMESTAMP::text)),
                true
            ),
            '{retention}',
            '"permanent"'::jsonb,
            true
        )
        WHERE source_type = 'web'
          AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'feed_source_id')
          AND COALESCE(metadata->>'review_status', '') IN ('', 'imported_reviewable')
        """
    )
    op.execute(
        """
        UPDATE discovery_items AS item
        SET status = 'saved',
            reviewed_at = COALESCE(item.reviewed_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        FROM sources AS source
        WHERE item.source_id = source.id
          AND item.provider = 'web'
          AND item.status = 'recommended'
          AND source.source_type = 'web'
          AND NOT (COALESCE(source.metadata, '{}'::jsonb) ? 'feed_source_id')
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE sources
        SET metadata = COALESCE(metadata, '{}'::jsonb) - 'web_role' - 'collection_source_id'
        WHERE source_type = 'web'
        """
    )
