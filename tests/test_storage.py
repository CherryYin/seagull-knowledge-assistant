"""Tests for pkg.services.storage — MinIO storage service (mocked boto3)."""

from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from pkg.services.storage import StorageService


@pytest.fixture
def mock_s3_client():
    return MagicMock()


@pytest.fixture
def storage(mock_s3_client):
    with patch("pkg.services.storage.boto3") as mock_boto3:
        mock_boto3.client.return_value = mock_s3_client
        svc = StorageService()
    return svc


# ---------------------------------------------------------------------------
# build_object_key
# ---------------------------------------------------------------------------
class TestBuildObjectKey:
    def test_basic(self, storage):
        key = storage.build_object_key("sources", "src-1", "paper.pdf")
        assert key == "sources/src-1/paper.pdf"

    def test_with_category_name(self, storage):
        key = storage.build_object_key("sources", "src-1", "paper.pdf", category_name="general")
        assert key == "sources/general/src-1/paper.pdf"

    def test_no_filename(self, storage):
        key = storage.build_object_key("notes", "note-1", None)
        assert key == "notes/note-1/note-1"


# ---------------------------------------------------------------------------
# to_storage_uri / parse_storage_uri
# ---------------------------------------------------------------------------
class TestStorageUri:
    def test_round_trip(self, storage):
        uri = storage.to_storage_uri("sources/src-1/paper.pdf")
        assert uri == "minio://knowledge-graph/sources/src-1/paper.pdf"
        bucket, key = storage.parse_storage_uri(uri)
        assert bucket == "knowledge-graph"
        assert key == "sources/src-1/paper.pdf"

    def test_invalid_scheme(self, storage):
        with pytest.raises(ValueError):
            storage.parse_storage_uri("s3://bucket/key")

    def test_missing_path(self, storage):
        with pytest.raises(ValueError):
            storage.parse_storage_uri("minio://bucket")


# ---------------------------------------------------------------------------
# upload_bytes (sync path: _upload_bytes_sync)
# ---------------------------------------------------------------------------
class TestUploadBytes:
    def test_upload_calls_put_object(self, storage, mock_s3_client):
        # head_bucket succeeds → no create_bucket needed
        mock_s3_client.head_bucket.return_value = {}
        uri = storage._upload_bytes_sync(object_key="test/file.txt", data=b"hello")
        mock_s3_client.put_object.assert_called_once()
        call_kwargs = mock_s3_client.put_object.call_args[1]
        assert call_kwargs["Key"] == "test/file.txt"
        assert call_kwargs["Body"] == b"hello"
        assert "minio://" in uri

    def test_creates_bucket_if_not_exists(self, storage, mock_s3_client):
        error = ClientError({"Error": {"Code": "404"}}, "HeadBucket")
        mock_s3_client.head_bucket.side_effect = error
        storage._upload_bytes_sync(object_key="k", data=b"x")
        mock_s3_client.create_bucket.assert_called_once()

    @pytest.mark.asyncio
    async def test_async_wrapper(self, storage, mock_s3_client):
        mock_s3_client.head_bucket.return_value = {}
        uri = await storage.upload_bytes(object_key="test/file.txt", data=b"hello")
        assert "minio://" in uri


# ---------------------------------------------------------------------------
# generate_download_url (sync path: _generate_download_url_sync)
# ---------------------------------------------------------------------------
class TestGenerateDownloadUrl:
    def test_calls_presigned(self, storage, mock_s3_client):
        mock_s3_client.generate_presigned_url.return_value = "https://minio/signed"
        url = storage._generate_download_url_sync("minio://knowledge-graph/exports/doc.pdf")
        assert url == "https://minio/signed"
        mock_s3_client.generate_presigned_url.assert_called_once()

    @pytest.mark.asyncio
    async def test_async_wrapper(self, storage, mock_s3_client):
        mock_s3_client.generate_presigned_url.return_value = "https://minio/signed"
        url = await storage.generate_download_url("minio://knowledge-graph/exports/doc.pdf")
        assert url == "https://minio/signed"


# ---------------------------------------------------------------------------
# delete_object (sync path: _delete_object_sync)
# ---------------------------------------------------------------------------
class TestDeleteObject:
    def test_calls_delete(self, storage, mock_s3_client):
        storage._delete_object_sync("minio://knowledge-graph/exports/doc.pdf")
        mock_s3_client.delete_object.assert_called_once_with(
            Bucket="knowledge-graph", Key="exports/doc.pdf"
        )

    @pytest.mark.asyncio
    async def test_async_wrapper(self, storage, mock_s3_client):
        await storage.delete_object("minio://knowledge-graph/exports/doc.pdf")
        mock_s3_client.delete_object.assert_called_once()


# ---------------------------------------------------------------------------
# get_object (sync path: _get_object_sync)
# ---------------------------------------------------------------------------
class TestGetObject:
    def test_calls_get(self, storage, mock_s3_client):
        body_mock = MagicMock()
        body_mock.read.return_value = b"file-content"
        mock_s3_client.get_object.return_value = {"Body": body_mock}
        data = storage._get_object_sync("minio://knowledge-graph/docs/file.txt")
        assert data == b"file-content"
        mock_s3_client.get_object.assert_called_once_with(
            Bucket="knowledge-graph", Key="docs/file.txt"
        )

    @pytest.mark.asyncio
    async def test_async_wrapper(self, storage, mock_s3_client):
        body_mock = MagicMock()
        body_mock.read.return_value = b"file-content"
        mock_s3_client.get_object.return_value = {"Body": body_mock}
        data = await storage.get_object("minio://knowledge-graph/docs/file.txt")
        assert data == b"file-content"
