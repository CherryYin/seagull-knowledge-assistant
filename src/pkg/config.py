from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    DATABASE_URL: str = (
        "postgresql+asyncpg://kg_user:kg_password@localhost:5433/knowledge_graph"
    )
    DATABASE_URL_SYNC: str = (
        "postgresql+psycopg://kg_user:kg_password@localhost:5433/knowledge_graph"
    )
    MINIO_ENDPOINT: str = "http://127.0.0.1:9000"
    MINIO_ACCESS_KEY: str = "minioadmin"
    MINIO_SECRET_KEY: str = "minioadmin"
    MINIO_BUCKET: str = "knowledge-graph"
    MINIO_REGION: str = "us-east-1"
    MINIO_PRESIGNED_EXPIRY_SECONDS: int = 3600
    EMBEDDING_MODEL: str = "text-embedding-v4"
    EMBEDDING_DIM: int = 1024
    EMBEDDING_API_BASE: str = ""
    EMBEDDING_API_KEY: str = ""
    DATA_DIR: Path = Path("./data")

    # LLM provider: "azure" or "qwen"
    LLM_PROVIDER: str = "qwen"

    # Azure OpenAI settings
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-12-01-preview"

    # Qwen API settings (OpenAI-compatible)
    QWEN_API_BASE: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    QWEN_API_KEY: str = ""
    QWEN_MODEL: str = "qwen-plus"

    @property
    def resolved_embedding_api_base(self) -> str:
        return self.EMBEDDING_API_BASE or self.QWEN_API_BASE

    @property
    def resolved_embedding_api_key(self) -> str:
        return self.EMBEDDING_API_KEY or self.QWEN_API_KEY

    @property
    def sources_dir(self) -> Path:
        return self.DATA_DIR / "sources"

    @property
    def notes_dir(self) -> Path:
        return self.DATA_DIR / "notes"


settings = Settings()
