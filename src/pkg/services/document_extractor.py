"""Document content extraction service powered by Docling.

Converts binary documents (PDF, DOCX, PPTX, XLSX, images, etc.) into
Markdown text. Handles both native and scanned (OCR) documents.

Usage:
    from pkg.services.document_extractor import extract_content

    # From bytes (e.g. file upload)
    markdown = extract_content(payload, filename="report.pdf")

    # From a local file path
    markdown = extract_content_from_path("/path/to/doc.pdf")
"""
import logging
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# File extensions that Docling can handle
DOCLING_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx",
    ".html", ".htm",
    ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp",
}


def _is_docling_supported(filename: str) -> bool:
    """Check if the file type is supported by Docling."""
    suffix = Path(filename).suffix.lower()
    return suffix in DOCLING_EXTENSIONS


def _build_converter():
    """Build a Docling DocumentConverter with OCR enabled."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pdf_options = PdfPipelineOptions()
    pdf_options.do_ocr = True
    pdf_options.do_table_structure = True

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        }
    )
    return converter


# Lazy singleton — converter is expensive to build (loads models)
_converter = None


def _get_converter():
    global _converter
    if _converter is None:
        logger.info("Initializing Docling DocumentConverter (first use)...")
        _converter = _build_converter()
        logger.info("Docling DocumentConverter ready.")
    return _converter


def extract_content_from_path(file_path: str | Path) -> str:
    """Extract text content from a local file using Docling.

    Returns Markdown string. Raises on failure.
    """
    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    converter = _get_converter()
    result = converter.convert(str(file_path))
    return result.document.export_to_markdown()


def extract_content(payload: bytes, filename: str) -> str | None:
    """Extract text content from file bytes using Docling.

    Writes bytes to a temp file, converts with Docling, returns Markdown.
    Returns None if the file type is not supported by Docling.
    """
    if not _is_docling_supported(filename):
        return None

    suffix = Path(filename).suffix.lower()

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(payload)
        tmp.flush()
        try:
            return extract_content_from_path(tmp.name)
        except Exception:
            logger.exception("Docling extraction failed for %s", filename)
            return None
