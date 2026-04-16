from pathlib import Path

from pydantic import Field
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

    # Docling PDF: OCR + table structure load models; first PDF can take minutes on CPU.
    # Set DOCLING_OCR=false or DOCLING_TABLE_STRUCTURE=false in .env to speed up if you only need text-layer PDFs.
    DOCLING_OCR: bool = True
    DOCLING_TABLE_STRUCTURE: bool = True

    # OCR engine: "tesseract" (fast, system-level) or "rapidocr" (onnxruntime-based).
    DOCLING_OCR_ENGINE: str = Field(
        default="tesseract",
        pattern=r"^(tesseract|rapidocr)$",
    )

    # Tesseract language codes (3-letter ISO 639-2). Requires matching tesseract-ocr-* packages.
    DOCLING_TESSERACT_LANGS: list[str] = ["eng", "chi_sim"]
    # Path to tessdata directory. Auto-detected if empty.
    DOCLING_TESSDATA_PREFIX: str = "/usr/share/tesseract-ocr/4.00/tessdata"

    # RapidOCR backend (only used when DOCLING_OCR_ENGINE=rapidocr).
    DOCLING_RAPIDOCR_BACKEND: str = Field(
        default="onnxruntime",
        pattern=r"^(onnxruntime|openvino|paddle|torch)$",
    )
    # False skips angle-classification (slightly faster; worse on rotated scans).
    DOCLING_OCR_USE_ANGLE_CLS: bool = True

    # LLM provider: "azure" or "qwen"
    LLM_PROVIDER: str = "qwen"

    # Tavily web search
    TAVILY_API_KEY: str = ""

    # Azure OpenAI settings
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-12-01-preview"

    # Qwen API settings (OpenAI-compatible)
    QWEN_API_BASE: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    QWEN_API_KEY: str = ""
    QWEN_MODEL: str = "qwen-plus"

    # Context compaction settings (SummarizingConversationManager)
    COMPACTION_SUMMARY_RATIO: float = 0.4
    COMPACTION_PRESERVE_RECENT: int = 6

    # LLM retry settings (ModelRetryStrategy)
    LLM_RETRY_MAX_ATTEMPTS: int = 6
    LLM_RETRY_INITIAL_DELAY: int = 4
    LLM_RETRY_MAX_DELAY: int = 240

    # Chunking settings for long document embedding
    CHUNK_SIZE: int = 512       # target chunk size in characters
    CHUNK_OVERLAP: int = 64     # overlap between consecutive chunks

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

    @property
    def skills_dir(self) -> Path:
        return Path("./skills")


settings = Settings()
