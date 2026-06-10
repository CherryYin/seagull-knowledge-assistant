import json
import os
from pathlib import Path

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMProviderConfig(BaseModel):
    id: str
    display_name: str
    base_url: str
    api_key: str = ""
    api_key_env: str | None = None
    default_model: str | None = None


class ManualLLMModelConfig(BaseModel):
    id: str
    provider_id: str
    display_name: str | None = None

    def resolve_api_key(self) -> str:
        if self.api_key_env:
            return os.environ.get(self.api_key_env, self.api_key)
        return self.api_key


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

    # Legacy — only used as fallback when LLM_PROVIDERS is not configured
    LLM_PROVIDER: str = "qwen"

    # Tavily web search
    TAVILY_API_KEY: str = ""

    # Legacy — Azure OpenAI (fallback only)
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-12-01-preview"

    # Legacy — Qwen API (fallback only, also used for embedding API key resolution)
    QWEN_API_BASE: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    QWEN_API_KEY: str = ""
    QWEN_MODEL: str = "qwen-plus"

    # MiniMax API (OpenAI-compatible, recommended via LLM_PROVIDERS)
    MINIMAX_API_BASE: str = "https://api.minimax.io/v1"
    MINIMAX_API_KEY: str = ""
    MINIMAX_MODEL: str = ""

    # Deprecated — agent_profiles now uses dynamic model discovery via /knowledge/models
    ALLOWED_MODELS: list[str] = ["qwen-plus", "qwen-max", "qwen-turbo"]

    # LLM provider registry — JSON array of {id, display_name, base_url, api_key, default_model?}
    LLM_PROVIDERS: str = "[]"
    # Manual model registry — JSON array of {id, provider_id, display_name?}
    # Useful when a provider does not implement GET /models.
    MANUAL_LLM_MODELS: str = "[]"

    # Context compaction settings (SummarizingConversationManager)
    COMPACTION_SUMMARY_RATIO: float = 0.4
    COMPACTION_PRESERVE_RECENT: int = 6

    # Workspace profile injected into the default Action Agent system prompt.
    AGENT_LOAD_WORKSPACE_PROFILE: bool = True
    AGENT_WORKSPACE_PROFILE_PATH: Path = Path("AGENTS.md")
    AGENT_WORKSPACE_PROFILE_MAX_CHARS: int = 12000

    # User profiler settings
    PROFILE_UPDATE_DAY: int = 0  # 0=Monday, 6=Sunday

    # LLM retry settings (ModelRetryStrategy)
    LLM_RETRY_MAX_ATTEMPTS: int = 6
    LLM_RETRY_INITIAL_DELAY: int = 4
    LLM_RETRY_MAX_DELAY: int = 240

    # JWT / Auth settings
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_DAYS: int = 7
    ADMIN_INIT_PASSWORD: str = ""

    # Chunking settings for long document embedding
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    CHUNK_MAX_TOKENS: int = 2048  # max tokens per chunk (tiktoken)

    # RSS feed settings
    RSS_AUTO_FETCH_ENABLED: bool = False
    RSS_AUTO_SUMMARY_ENABLED: bool = False
    RSS_FETCH_INTERVAL_HOURS: int = 24
    RSS_SUMMARY_INTERVAL_HOURS: int = 24
    RSS_FETCH_TIMEOUT: int = 30
    RSS_MAX_ARTICLES_PER_FEED: int = 20
    RSS_RETENTION_DAYS: int = 30
    RSS_SUMMARY_LLM_TIMEOUT: int = 180
    RSS_SUMMARY_MAX_ARTICLES: int = 12
    RSS_SUMMARY_MAX_CHARS_PER_ARTICLE: int = 1500
    RSS_FILTER_LOW_VALUE: bool = True

    # External connector trend discovery. Disabled by default so app startup does not fetch external sources.
    ARXIV_USER_AGENT: str = "personal-knowledge-graph/0.1"
    ARXIV_MIN_REQUEST_INTERVAL_SECONDS: float = 3.0
    ARXIV_RETRY_INITIAL_DELAY_SECONDS: float = 5.0
    ARXIV_RETRY_MAX_DELAY_SECONDS: float = 60.0
    SEMANTIC_SCHOLAR_API_URL: str = "https://api.semanticscholar.org/graph/v1"
    SEMANTIC_SCHOLAR_API_KEY: str = ""
    SEMANTIC_SCHOLAR_USER_AGENT: str = "personal-knowledge-graph/0.1"
    SEMANTIC_SCHOLAR_MIN_REQUEST_INTERVAL_SECONDS: float = 1.0
    SEMANTIC_SCHOLAR_TIMEOUT_SECONDS: float = 20.0
    SEMANTIC_SCHOLAR_RETRY_INITIAL_DELAY_SECONDS: float = 2.0
    SEMANTIC_SCHOLAR_RETRY_MAX_DELAY_SECONDS: float = 30.0
    CONNECTOR_TRENDS_AUTO_ENABLED: bool = False
    CONNECTOR_TRENDS_INTERVAL_HOURS: int = 24
    CONNECTOR_TRENDS_USER_IDS: str = ""
    CONNECTOR_TRENDS_ARXIV_QUERY: str = "artificial intelligence OR retrieval augmented generation OR agents"
    CONNECTOR_TRENDS_ARXIV_CATEGORY: str = "cs.AI"
    CONNECTOR_TRENDS_GITHUB_QUERY: str = "agent framework OR retrieval augmented generation OR knowledge graph"
    CONNECTOR_TRENDS_GITHUB_LANGUAGE: str = ""
    DISCOVERY_AUTO_GENERATE_ENABLED: bool = False
    DISCOVERY_GENERATE_INTERVAL_HOURS: int = 24
    PAPER_DISCOVERY_AUTO_ENABLED: bool = False
    PAPER_DISCOVERY_INTERVAL_HOURS: int = 24
    OPENALEX_API_KEY: str = ""
    
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

    def get_llm_providers(self) -> list[LLMProviderConfig]:
        """Parse LLM_PROVIDERS JSON. Falls back to a single provider from legacy QWEN_* config."""
        try:
            raw = json.loads(self.LLM_PROVIDERS)
        except (json.JSONDecodeError, TypeError):
            raw = []
        if raw:
            return [LLMProviderConfig(**entry) for entry in raw]
        if self.QWEN_API_KEY:
            return [LLMProviderConfig(
                id="qwen",
                display_name="Qwen",
                base_url=self.QWEN_API_BASE,
                api_key=self.QWEN_API_KEY,
                default_model=self.QWEN_MODEL,
            )]
        return []

    def get_provider(self, provider_id: str) -> LLMProviderConfig | None:
        for p in self.get_llm_providers():
            if p.id == provider_id:
                return p
        return None

    def get_manual_llm_models(self) -> list[ManualLLMModelConfig]:
        try:
            raw = json.loads(self.MANUAL_LLM_MODELS)
        except (json.JSONDecodeError, TypeError):
            raw = []
        if not raw:
            return []
        return [ManualLLMModelConfig(**entry) for entry in raw]


settings = Settings()
