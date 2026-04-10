"""Document content extraction service powered by Docling.

Converts binary documents (PDF, DOCX, PPTX, XLSX, images, etc.) into
Markdown text. Handles both native and scanned (OCR) documents.

Usage:
    from pkg.services.document_extractor import extract_content

    # From bytes (e.g. file upload)
    markdown = extract_content(payload, filename="report.pdf")

    # From a local file path
    markdown = extract_content_from_path("/path/to/doc.pdf")

    # With progress callback (for progress bars)
    def on_progress(current_page, total_pages):
        print(f"Page {current_page}/{total_pages}")
    markdown = extract_content_from_path("doc.pdf", progress=on_progress)
"""
import logging
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

from pkg.config import settings

logger = logging.getLogger(__name__)

# One-time: surface Docling + RapidOCR on the same handlers as uvicorn (often only root is configured).
_extraction_loggers_configured = False


def _configure_extraction_loggers() -> None:
    global _extraction_loggers_configured
    if _extraction_loggers_configured:
        return
    _extraction_loggers_configured = True
    root = logging.getLogger()
    if not root.handlers:
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
        root.addHandler(h)
        root.setLevel(logging.INFO)
    for name in ("docling", "RapidOCR"):
        lg = logging.getLogger(name)
        lg.setLevel(logging.INFO)
        lg.propagate = True
    logging.getLogger("docling.document_converter").setLevel(logging.INFO)
    logging.getLogger("docling.models").setLevel(logging.INFO)
    logging.getLogger("docling.pipeline").setLevel(logging.INFO)

# File extensions that Docling can handle
DOCLING_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx",
    ".html", ".htm",
    ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp",
}

# Type for progress callbacks: (current_page, total_pages) -> None
ProgressCallback = Callable[[int, int], None]

# Docling logs this at DEBUG on each page batch (see docling.pipeline.base_pipeline).
_PAGE_PROGRESS_RE = re.compile(r"Finished converting pages (\d+)/(\d+)")

# Logger name used by BasePipeline in Docling (must match for DEBUG page-batch lines).
_DOCLING_PIPELINE_LOGGER = "docling.pipeline.base_pipeline"


def _is_docling_supported(filename: str) -> bool:
    """Check if the file type is supported by Docling."""
    suffix = Path(filename).suffix.lower()
    return suffix in DOCLING_EXTENSIONS


class _DoclingPageProgressHandler(logging.Handler):
    """Reads Docling pipeline DEBUG logs and emits INFO progress + optional user callback."""

    def __init__(self, user_callback: ProgressCallback | None = None):
        super().__init__(level=logging.DEBUG)
        self.user_callback = user_callback

    def emit(self, record: logging.LogRecord) -> None:
        try:
            m = _PAGE_PROGRESS_RE.search(record.getMessage())
            if not m:
                return
            current = int(m.group(1))
            total = int(m.group(2))
            pct = int(100 * current / total) if total else 0
            logger.info("[docling] PDF progress: %d/%d pages (~%d%%)", current, total, pct)
            sys.stderr.flush()
            if self.user_callback is not None:
                self.user_callback(current, total)
        except Exception:
            self.handleError(record)


def _build_converter():
    """Build a Docling DocumentConverter. OCR + table models load PyTorch and can block for minutes on first use."""
    _configure_extraction_loggers()
    t0 = time.monotonic()

    logger.info(
        "[docling] Step 1/4: importing Docling modules (may load torch)…",
    )
    sys.stderr.flush()
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    logger.info("[docling] Step 2/4: PdfPipelineOptions (OCR=%s, table_structure=%s)", settings.DOCLING_OCR, settings.DOCLING_TABLE_STRUCTURE)
    sys.stderr.flush()
    pdf_options = PdfPipelineOptions()
    pdf_options.do_ocr = settings.DOCLING_OCR
    pdf_options.do_table_structure = settings.DOCLING_TABLE_STRUCTURE

    if settings.DOCLING_OCR:
        if settings.DOCLING_OCR_ENGINE == "tesseract":
            from docling.datamodel.pipeline_options import TesseractOcrOptions

            # tesserocr.get_languages() reads TESSDATA_PREFIX env var directly
            if settings.DOCLING_TESSDATA_PREFIX:
                import os
                os.environ.setdefault("TESSDATA_PREFIX", settings.DOCLING_TESSDATA_PREFIX)

            pdf_options.ocr_options = TesseractOcrOptions(
                lang=settings.DOCLING_TESSERACT_LANGS,
                path=settings.DOCLING_TESSDATA_PREFIX or None,
            )
            logger.info(
                "[docling] Tesseract OCR: langs=%s tessdata=%s",
                settings.DOCLING_TESSERACT_LANGS,
                settings.DOCLING_TESSDATA_PREFIX,
            )
        else:
            from docling.datamodel.pipeline_options import RapidOcrOptions

            ocr_kw: dict = {"backend": settings.DOCLING_RAPIDOCR_BACKEND}
            if not settings.DOCLING_OCR_USE_ANGLE_CLS:
                ocr_kw["use_cls"] = False
            pdf_options.ocr_options = RapidOcrOptions(**ocr_kw)
            logger.info(
                "[docling] RapidOCR: backend=%s use_angle_cls=%s",
                settings.DOCLING_RAPIDOCR_BACKEND,
                settings.DOCLING_OCR_USE_ANGLE_CLS,
            )
        sys.stderr.flush()

    if settings.DOCLING_OCR or settings.DOCLING_TABLE_STRUCTURE:
        logger.warning(
            "[docling] Heavy pipeline enabled — first build often takes 2–10+ minutes on CPU; "
            "logs from RapidOCR/docling may pause after a progress bar while more models load.",
        )

    logger.info(
        "[docling] Step 3/4: building DocumentConverter (loading layout/OCR/table weights — please wait)…",
    )
    sys.stderr.flush()
    t_conv = time.monotonic()
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        }
    )
    elapsed_conv = time.monotonic() - t_conv
    elapsed_total = time.monotonic() - t0
    logger.info(
        "[docling] Step 4/4: DocumentConverter ready (converter init %.1fs, total _build_converter %.1fs)",
        elapsed_conv,
        elapsed_total,
    )
    sys.stderr.flush()
    return converter


# Lazy singleton — converter is expensive to build (loads models)
_converter = None


def _get_converter():
    global _converter
    if _converter is None:
        logger.info("[docling] Lazy init: creating singleton converter (first PDF/upload/sync triggers this)…")
        sys.stderr.flush()
        _converter = _build_converter()
    return _converter


def extract_content_from_path(
    file_path: str | Path,
    progress: ProgressCallback | None = None,
) -> str:
    """Extract text content from a local file using Docling.

    Args:
        file_path: Path to the document file.
        progress: Optional callback ``(current_page, total_pages) -> None``
            called after each page batch is processed.

    Returns Markdown string. Raises on failure.
    """
    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    logger.info("[docling] extract_content_from_path: %s", file_path)
    sys.stderr.flush()
    converter = _get_converter()

    # Page-batch progress is logged by Docling at DEBUG; always tap it so server logs show PDF progress.
    handler = _DoclingPageProgressHandler(progress)
    pipeline_logger = logging.getLogger(_DOCLING_PIPELINE_LOGGER)
    _prev_level = pipeline_logger.level
    _prev_propagate = pipeline_logger.propagate
    pipeline_logger.addHandler(handler)
    pipeline_logger.setLevel(logging.DEBUG)
    pipeline_logger.propagate = True

    try:
        logger.info("[docling] convert() starting: %s", file_path.name)
        sys.stderr.flush()
        t0 = time.monotonic()
        result = converter.convert(str(file_path))
        logger.info("[docling] convert() done: %s (%.1fs)", file_path.name, time.monotonic() - t0)
        sys.stderr.flush()
        # Final callback so callers see 100% even if last batch log was skipped
        if result.pages:
            total = len(result.pages)
            logger.info("[docling] PDF progress: %d/%d pages (complete)", total, total)
            sys.stderr.flush()
            if progress is not None:
                progress(total, total)
        return result.document.export_to_markdown()
    finally:
        pipeline_logger.removeHandler(handler)
        pipeline_logger.setLevel(_prev_level)
        pipeline_logger.propagate = _prev_propagate


def extract_content(
    payload: bytes,
    filename: str,
    progress: ProgressCallback | None = None,
) -> str | None:
    """Extract text content from file bytes using Docling.

    Writes bytes to a temp file, converts with Docling, returns Markdown.
    Returns None if the file type is not supported by Docling.

    Args:
        payload: Raw file bytes.
        filename: Original filename (used to detect format).
        progress: Optional callback ``(current_page, total_pages) -> None``.
    """
    if not _is_docling_supported(filename):
        return None

    logger.info("[docling] extract_content: %s (%d bytes)", filename, len(payload))
    sys.stderr.flush()

    suffix = Path(filename).suffix.lower()

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(payload)
        tmp.flush()
        try:
            return extract_content_from_path(tmp.name, progress=progress)
        except Exception:
            logger.exception("Docling extraction failed for %s", filename)
            return None
