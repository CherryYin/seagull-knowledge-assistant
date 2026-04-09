from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

from pkg.config import settings


class StorageService:
    def __init__(self):
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.MINIO_ENDPOINT,
            aws_access_key_id=settings.MINIO_ACCESS_KEY,
            aws_secret_access_key=settings.MINIO_SECRET_KEY,
            region_name=settings.MINIO_REGION,
        )
        self._bucket_checked = False

    @property
    def bucket(self) -> str:
        return settings.MINIO_BUCKET

    @property
    def client(self):
        return self._client

    def _ensure_bucket(self) -> None:
        if self._bucket_checked:
            return

        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code not in {"404", "NoSuchBucket"}:
                raise
            self.client.create_bucket(Bucket=self.bucket)

        self._bucket_checked = True

    def build_object_key(self, category: str, item_id: str, filename: str | None) -> str:
        safe_name = Path(filename or item_id).name or item_id
        return f"{category}/{item_id}/{safe_name}"

    def upload_bytes(
        self,
        *,
        object_key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> str:
        self._ensure_bucket()
        self.client.put_object(
            Bucket=self.bucket,
            Key=object_key,
            Body=data,
            ContentType=content_type or "application/octet-stream",
        )
        return self.to_storage_uri(object_key)

    def to_storage_uri(self, object_key: str) -> str:
        return f"minio://{self.bucket}/{object_key}"

    def parse_storage_uri(self, storage_uri: str) -> tuple[str, str]:
        parsed = urlparse(storage_uri)
        if parsed.scheme != "minio" or not parsed.netloc or not parsed.path:
            raise ValueError(f"Unsupported storage URI: {storage_uri}")
        return parsed.netloc, parsed.path.lstrip("/")

    def generate_download_url(self, storage_uri: str) -> str:
        bucket, key = self.parse_storage_uri(storage_uri)
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=settings.MINIO_PRESIGNED_EXPIRY_SECONDS,
        )


@lru_cache(maxsize=1)
def get_storage_service() -> StorageService:
    return StorageService()
