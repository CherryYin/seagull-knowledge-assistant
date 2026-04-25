"""Document processing tool — converts markdown content to document files.

The main Agent generates content in markdown, then calls this tool to
convert it into the target format (DOCX, XLSX, PPTX, PDF).
"""
import logging
import mimetypes
import re
from datetime import datetime, timezone
from pathlib import Path

from strands import tool

from pkg.config import settings
from pkg.services.storage import get_storage_service

logger = logging.getLogger(__name__)

_SUPPORTED_FORMATS = {"docx", "xlsx", "pptx", "pdf", "md"}


def _output_path(filename: str, fmt: str) -> tuple[Path, str]:
    """Build output file path under DATA_DIR/exports/ and return the base name.

    Returns (local_path, base_filename_without_ext).
    """
    exports_dir = settings.DATA_DIR / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    if not filename:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        filename = f"doc-{ts}"
    # Strip any existing extension
    filename = Path(filename).stem
    return exports_dir / f"{filename}.{fmt}", filename


async def _upload_to_oss(local_path: Path) -> str:
    """Upload the generated file to MinIO under exports/ and return a presigned URL."""
    storage = get_storage_service()
    object_key = f"exports/{local_path.name}"
    content_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
    data = local_path.read_bytes()
    storage_uri = await storage.upload_bytes(
        object_key=object_key,
        data=data,
        content_type=content_type,
    )
    return await storage.generate_download_url(storage_uri)


def _md_to_docx(content: str, path: Path) -> None:
    """Convert markdown text to a DOCX file."""
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        # Headings
        if stripped.startswith("### "):
            doc.add_heading(stripped[4:], level=3)
        elif stripped.startswith("## "):
            doc.add_heading(stripped[3:], level=2)
        elif stripped.startswith("# "):
            doc.add_heading(stripped[2:], level=1)
        # Bullet lists
        elif stripped.startswith("- ") or stripped.startswith("* "):
            doc.add_paragraph(stripped[2:], style="List Bullet")
        # Numbered lists
        elif re.match(r"^\d+\.\s", stripped):
            text = re.sub(r"^\d+\.\s", "", stripped)
            doc.add_paragraph(text, style="List Number")
        # Normal paragraph
        else:
            doc.add_paragraph(stripped)

    doc.save(str(path))


def _md_to_xlsx(content: str, path: Path) -> None:
    """Convert markdown tables/text to an XLSX file.

    Detects markdown tables (| col1 | col2 |) and writes them as sheets.
    Non-table content goes into a 'Content' sheet.
    """
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Content"

    row_idx = 1
    for line in content.split("\n"):
        stripped = line.strip()
        # Skip separator lines like |---|---|
        if re.match(r"^\|[\s\-:|]+\|$", stripped):
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            for col_idx, cell in enumerate(cells, 1):
                ws.cell(row=row_idx, column=col_idx, value=cell)
            row_idx += 1
        elif stripped:
            ws.cell(row=row_idx, column=1, value=stripped)
            row_idx += 1

    wb.save(str(path))


def _md_to_pptx(content: str, path: Path) -> None:
    """Convert markdown to a PPTX file.

    Each '# heading' or '## heading' becomes a new slide title.
    Content below becomes bullet points.
    """
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()

    slides_data: list[tuple[str, list[str]]] = []
    current_title = ""
    current_bullets: list[str] = []

    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("# ") or stripped.startswith("## "):
            if current_title or current_bullets:
                slides_data.append((current_title, current_bullets))
            current_title = re.sub(r"^#+\s*", "", stripped)
            current_bullets = []
        elif stripped.startswith("### "):
            current_bullets.append(re.sub(r"^#+\s*", "", stripped))
        elif stripped.startswith("- ") or stripped.startswith("* "):
            current_bullets.append(stripped[2:])
        elif re.match(r"^\d+\.\s", stripped):
            current_bullets.append(re.sub(r"^\d+\.\s", "", stripped))
        elif stripped:
            current_bullets.append(stripped)

    if current_title or current_bullets:
        slides_data.append((current_title, current_bullets))

    for title, bullets in slides_data:
        slide_layout = prs.slide_layouts[1]  # Title and Content
        slide = prs.slides.add_slide(slide_layout)
        slide.shapes.title.text = title
        body = slide.placeholders[1]
        tf = body.text_frame
        tf.clear()
        for i, bullet in enumerate(bullets):
            if i == 0:
                tf.paragraphs[0].text = bullet
            else:
                p = tf.add_paragraph()
                p.text = bullet

    prs.save(str(path))


@tool
async def process_document(content: str, format: str, filename: str = "") -> str:
    """Convert markdown content into a document file (DOCX, XLSX, PPTX, PDF, MD).

    The Agent should first generate the document content in markdown format,
    then call this tool to convert it into the desired file format.

    Args:
        content: The document content in markdown format.
        format: Target format — one of: docx, xlsx, pptx, pdf, md.
        filename: Output filename (without extension). Auto-generated if empty.
    """
    fmt = format.lower().strip(".")
    if fmt not in _SUPPORTED_FORMATS:
        return f"不支持的格式: {format}。支持: {', '.join(sorted(_SUPPORTED_FORMATS))}"

    if not content.strip():
        return "错误: 内容为空，无法生成文档。"

    path, base_name = _output_path(filename, fmt)

    try:
        if fmt == "md":
            path.write_text(content, encoding="utf-8")
        elif fmt == "docx":
            _md_to_docx(content, path)
        elif fmt == "xlsx":
            _md_to_xlsx(content, path)
        elif fmt == "pptx":
            _md_to_pptx(content, path)
        elif fmt == "pdf":
            # Write as markdown first, then convert via docx as intermediate
            docx_path = path.with_suffix(".docx")
            _md_to_docx(content, docx_path)
            try:
                download_url = await _upload_to_oss(docx_path)
            except Exception as exc:
                logger.exception("Failed to upload DOCX to OSS")
                return (
                    f"已生成 DOCX 文件: {docx_path}\n"
                    f"（PDF 直接转换暂不支持，请使用 LibreOffice 或其他工具将 DOCX 转为 PDF）\n"
                    f"OSS 上传失败: {exc}"
                )
            return (
                f"已生成 DOCX 文件并上传至 OSS。\n"
                f"（PDF 直接转换暂不支持，已生成 DOCX 替代）\n"
                f"下载链接: {download_url}"
            )
    except Exception as exc:
        logger.exception("Failed to convert to %s", fmt)
        return f"文档转换失败: {exc}"

    try:
        download_url = await _upload_to_oss(path)
    except Exception as exc:
        logger.exception("Failed to upload to OSS")
        return f"已生成文件: {path}（OSS 上传失败: {exc}）"

    return f"已生成文件并上传至 OSS。\n下载链接: {download_url}"
