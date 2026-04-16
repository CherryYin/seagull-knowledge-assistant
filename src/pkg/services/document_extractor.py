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


def _build_converter(force_full_page_ocr: bool = False):
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

    logger.info("[docling] Step 2/4: PdfPipelineOptions (OCR=%s, table_structure=%s, force_full_page_ocr=%s)", settings.DOCLING_OCR, settings.DOCLING_TABLE_STRUCTURE, force_full_page_ocr)
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
                force_full_page_ocr=force_full_page_ocr,
            )
            logger.info(
                "[docling] Tesseract OCR: langs=%s tessdata=%s force_full_page=%s",
                settings.DOCLING_TESSERACT_LANGS,
                settings.DOCLING_TESSDATA_PREFIX,
                force_full_page_ocr,
            )
        else:
            from docling.datamodel.pipeline_options import RapidOcrOptions

            ocr_kw: dict = {"backend": settings.DOCLING_RAPIDOCR_BACKEND}
            if not settings.DOCLING_OCR_USE_ANGLE_CLS:
                ocr_kw["use_cls"] = False
            ocr_kw["force_full_page_ocr"] = force_full_page_ocr
            pdf_options.ocr_options = RapidOcrOptions(**ocr_kw)
            logger.info(
                "[docling] RapidOCR: backend=%s use_angle_cls=%s force_full_page=%s",
                settings.DOCLING_RAPIDOCR_BACKEND,
                settings.DOCLING_OCR_USE_ANGLE_CLS,
                force_full_page_ocr,
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


# Lazy singletons — converters are expensive to build (loads models)
_converter = None
_converter_force_ocr = None


def _get_converter(force_full_page_ocr: bool = False):
    global _converter, _converter_force_ocr
    if force_full_page_ocr:
        if _converter_force_ocr is None:
            logger.info("[docling] Lazy init: creating force-OCR converter…")
            sys.stderr.flush()
            _converter_force_ocr = _build_converter(force_full_page_ocr=True)
        return _converter_force_ocr
    else:
        if _converter is None:
            logger.info("[docling] Lazy init: creating singleton converter (first PDF/upload/sync triggers this)…")
            sys.stderr.flush()
            _converter = _build_converter()
        return _converter


def extract_content_from_path(
    file_path: str | Path,
    progress: ProgressCallback | None = None,
    force_full_page_ocr: bool = False,
) -> str:
    """Extract text content from a local file using Docling.

    Args:
        file_path: Path to the document file.
        progress: Optional callback ``(current_page, total_pages) -> None``
            called after each page batch is processed.
        force_full_page_ocr: If True, force OCR on every page (ignore text layer).

    Returns Markdown string. Raises on failure.
    """
    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    logger.info("[docling] extract_content_from_path: %s (force_ocr=%s)", file_path, force_full_page_ocr)
    sys.stderr.flush()
    converter = _get_converter(force_full_page_ocr=force_full_page_ocr)

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
        return result.document.export_to_markdown(image_placeholder="")
    finally:
        pipeline_logger.removeHandler(handler)
        pipeline_logger.setLevel(_prev_level)
        pipeline_logger.propagate = _prev_propagate


def _looks_garbled(text: str, sample_size: int = 500) -> bool:
    """Heuristic: detect garbled CJK text from broken CMap font encodings.

    These PDFs produce a characteristic mix of CJK Extension A/B chars (rare),
    Cyrillic, modifier letters, and other unrelated scripts that never appear
    together in real Chinese/Japanese/Korean text.
    """
    if not text.strip():
        return False
    sample = text[:sample_size]
    suspicious = 0
    total = 0
    for ch in sample:
        cp = ord(ch)
        if ch.isspace():
            continue
        total += 1
        # Characters that are individually valid Unicode but shouldn't appear
        # frequently in normal CJK text — hallmarks of GBK CMap mis-decode:
        if (0x3400 <= cp <= 0x4DBF       # CJK Unified Ideographs Extension A (rare chars)
            or 0x0400 <= cp <= 0x04FF     # Cyrillic
            or 0x0250 <= cp <= 0x02FF     # IPA / Modifier letters (ˈ ˄ ˅ etc.)
            or 0x0700 <= cp <= 0x07FF     # Syriac / Thaana / NKo
            or 0x1400 <= cp <= 0x167F     # Canadian Aboriginal / Ogham / Runic
            or 0x1680 <= cp <= 0x169F     # Ogham
            or 0x19A0 <= cp <= 0x19FF     # New Tai Lue
            or 0x1580 <= cp <= 0x15FF     # Unified Canadian Aboriginal (extended)
            or 0x1100 <= cp <= 0x11FF     # Hangul Jamo
        ):
            suspicious += 1
    if total == 0:
        return False
    ratio = suspicious / total
    return ratio > 0.10


def extract_text_pymupdf(source: str | Path | bytes) -> str:
    """Fast text extraction using PyMuPDF — for text-based PDFs only (no OCR).

    Accepts a file path or raw PDF bytes. Falls back to Docling force-OCR
    if the extracted text appears garbled (broken CMap encoding).
    """
    import pymupdf

    if isinstance(source, bytes):
        label = "<bytes>"
        doc = pymupdf.open(stream=source, filetype="pdf")
    else:
        source = Path(source)
        if not source.exists():
            raise FileNotFoundError(f"File not found: {source}")
        label = source.name
        doc = pymupdf.open(str(source))

    logger.info("[pymupdf] extracting text: %s", label)
    t0 = time.monotonic()
    pages = []
    for page in doc:
        pages.append(page.get_text("text"))
    doc.close()
    elapsed = time.monotonic() - t0
    logger.info("[pymupdf] done: %s (%d pages, %.1fs)", label, len(pages), elapsed)

    result = "\n\n".join(pages)
    if _looks_garbled(result):
        logger.warning(
            "[pymupdf] text looks garbled (non-Unicode CMap font?) — falling back to Docling force-OCR: %s",
            label,
        )
        if isinstance(source, bytes):
            return extract_content(source, "document.pdf", force_full_page_ocr=True)
        return extract_content_from_path(source, force_full_page_ocr=True)
    return result


def extract_content_pymupdf(
    payload: bytes,
    filename: str,
) -> str | None:
    """Extract text from PDF bytes using PyMuPDF (fast, no OCR).

    Falls back to Docling if the extracted text appears garbled.
    Returns None if the file is not a PDF or extraction fails.
    """
    suffix = Path(filename).suffix.lower()
    if suffix != ".pdf":
        return None

    logger.info("[pymupdf] extract_content_pymupdf: %s (%d bytes)", filename, len(payload))
    try:
        return extract_text_pymupdf(payload)
    except Exception:
        logger.exception("PyMuPDF extraction failed for %s", filename)
        return None


def extract_content(
    payload: bytes,
    filename: str,
    progress: ProgressCallback | None = None,
    force_full_page_ocr: bool = False,
) -> str | None:
    """Extract text content from file bytes using Docling.

    Writes bytes to a temp file, converts with Docling, returns Markdown.
    Returns None if the file type is not supported by Docling.

    Args:
        payload: Raw file bytes.
        filename: Original filename (used to detect format).
        progress: Optional callback ``(current_page, total_pages) -> None``.
        force_full_page_ocr: If True, force OCR on every page (ignore text layer).
    """
    if not _is_docling_supported(filename):
        return None

    logger.info("[docling] extract_content: %s (%d bytes, force_ocr=%s)", filename, len(payload), force_full_page_ocr)
    sys.stderr.flush()

    suffix = Path(filename).suffix.lower()

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(payload)
        tmp.flush()
        try:
            return extract_content_from_path(tmp.name, progress=progress, force_full_page_ocr=force_full_page_ocr)
        except Exception:
            logger.exception("Docling extraction failed for %s", filename)
            return None


# ---------------------------------------------------------------------------
# VLM-based extraction: render pages as images, send to vision LLM
# ---------------------------------------------------------------------------

_VLM_SYSTEM_PROMPT = """\
你是一个文档转录助手。请完整、准确地转录图片中的所有文字内容。
要求：
- 使用Markdown格式
- 保留原文的段落结构、标题层级、列表和表格
- 如有页眉页脚或页码，忽略它们
- 不要添加任何解释或总结，只输出原文内容"""


async def _vlm_describe_page(
    client,
    model: str,
    page_b64: str,
    page_num: int,
    total_pages: int,
    semaphore,
    counter: dict,
    progress: ProgressCallback | None = None,
    max_retries: int = 2,
) -> str:
    """Send a single page image to the vision LLM and return its markdown transcription."""
    import asyncio

    async with semaphore:
        for attempt in range(1, max_retries + 1):
            try:
                logger.info("[vlm] requesting page %d/%d (attempt %d)", page_num, total_pages, attempt)
                sys.stderr.flush()
                response = await asyncio.wait_for(
                    client.chat.completions.create(
                        model=model,
                        messages=[
                            {"role": "system", "content": _VLM_SYSTEM_PROMPT},
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": f"data:image/png;base64,{page_b64}"},
                                    },
                                    {
                                        "type": "text",
                                        "text": "请完整转录这一页的所有文字内容。",
                                    },
                                ],
                            },
                        ],
                    ),
                    timeout=120,
                )
                text = response.choices[0].message.content or ""
                counter["done"] += 1
                done = counter["done"]
                pct = int(100 * done / total_pages) if total_pages else 0
                logger.info("[vlm] progress: %d/%d pages done (~%d%%) — page %d returned %d chars", done, total_pages, pct, page_num, len(text))
                sys.stderr.flush()
                if progress is not None:
                    progress(done, total_pages)
                return text
            except (asyncio.TimeoutError, Exception) as exc:
                logger.warning("[vlm] page %d/%d attempt %d failed: %s", page_num, total_pages, attempt, exc)
                sys.stderr.flush()
                if attempt < max_retries:
                    await asyncio.sleep(2)
                    continue
                # All retries exhausted — return placeholder
                counter["done"] += 1
                done = counter["done"]
                logger.error("[vlm] page %d/%d failed after %d attempts, skipping", page_num, total_pages, max_retries)
                sys.stderr.flush()
                if progress is not None:
                    progress(done, total_pages)
                return f"[第{page_num}页识别失败]"


async def extract_content_vlm(
    source: str | Path | bytes,
    progress: ProgressCallback | None = None,
) -> str:
    """Extract text from a PDF by rendering each page as an image and sending to a vision LLM.

    Accepts a file path or raw PDF bytes.
    Pages are processed in parallel (up to 4 concurrent requests).
    Returns combined Markdown string.
    """
    import asyncio
    import base64

    import pymupdf
    from openai import AsyncOpenAI

    if isinstance(source, bytes):
        label = "<bytes>"
        doc = pymupdf.open(stream=source, filetype="pdf")
    else:
        source = Path(source)
        if not source.exists():
            raise FileNotFoundError(f"File not found: {source}")
        label = str(source)
        doc = pymupdf.open(str(source))

    logger.info("[vlm] rendering pages to images: %s", label)
    sys.stderr.flush()
    t0 = time.monotonic()
    total_pages = len(doc)

    # Render all pages to base64 PNG
    page_images: list[str] = []
    for page in doc:
        pix = page.get_pixmap(dpi=200)
        page_images.append(base64.b64encode(pix.tobytes("png")).decode("ascii"))
    doc.close()
    logger.info("[vlm] rendered %d pages (%.1fs)", total_pages, time.monotonic() - t0)
    sys.stderr.flush()

    # Create LLM client with generous timeout for vision requests
    client = AsyncOpenAI(
        base_url=settings.QWEN_API_BASE,
        api_key=settings.QWEN_API_KEY,
        timeout=120.0,
    )
    model = settings.QWEN_MODEL

    # Process pages in parallel with concurrency limit
    semaphore = asyncio.Semaphore(4)
    counter = {"done": 0}
    tasks = [
        _vlm_describe_page(client, model, b64, i + 1, total_pages, semaphore, counter, progress)
        for i, b64 in enumerate(page_images)
    ]
    results = await asyncio.gather(*tasks)

    elapsed = time.monotonic() - t0
    logger.info("[vlm] all %d pages done (%.1fs total)", total_pages, elapsed)
    sys.stderr.flush()
    return "\n\n---\n\n".join(results)


async def extract_content_vlm_from_bytes(
    payload: bytes,
    filename: str,
    progress: ProgressCallback | None = None,
) -> str | None:
    """Extract text from PDF bytes using VLM page-by-page description.

    Returns None if the file is not a PDF or extraction fails.
    """
    suffix = Path(filename).suffix.lower()
    if suffix != ".pdf":
        return None

    logger.info("[vlm] extract_content_vlm_from_bytes: %s (%d bytes)", filename, len(payload))
    sys.stderr.flush()
    try:
        return await extract_content_vlm(payload, progress=progress)
    except Exception:
        logger.exception("VLM extraction failed for %s", filename)
        return None
