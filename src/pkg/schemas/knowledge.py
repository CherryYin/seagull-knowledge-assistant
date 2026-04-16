from pydantic import BaseModel


class SaveDocumentRequest(BaseModel):
    storage_uri: str        # minio://bucket/exports/filename.ext
    document_format: str    # docx, xlsx, pptx, pdf, md
    document_filename: str
    message_content: str
    session_id: str | None = None
    category_id: int | None = None


class SaveDocumentResponse(BaseModel):
    source_id: str
    note_id: str


class RememberRequest(BaseModel):
    content: str
    session_id: str | None = None
    title: str | None = None
    category_id: int | None = None
