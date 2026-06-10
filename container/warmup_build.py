"""
warmup_build.py — run at IMAGE BUILD time (best-effort) to bake the Docling +
Surya OCR model weights into the image layer, so a cold-started container does
not pay a multi-minute model-download tax on its first real request.

It synthesises a small one-page PDF (via Pillow, already a Docling dependency)
that contains real TEXT and a simple TABLE-like grid, then runs a full Docling
conversion over it. That forces ALL three CPU model families to download into
HF_HOME / XDG_CACHE_HOME (which are baked into the image):

  * layout detection            — every page goes through it
  * Surya OCR text RECOGNITION  — only fires when there is text to read, so the
                                  blank page the previous version used never
                                  exercised (and therefore never downloaded) it
  * table-structure model       — only fires when a table region is detected,
                                  so we draw a ruled grid to trigger it

Invoked as `python warmup_build.py || true` (see Dockerfile) so a build never
fails on this — at worst the models lazily download on the container's first
real request, exactly as before.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path


def _render_warmup_pdf(path: Path) -> None:
    """Draw a single page with a heading, body text and a 3x3 ruled grid, then
    save it as a 1-page PDF. Pillow infers PDF from the .pdf suffix.

    The text gives the OCR recognition model something to decode; the ruled grid
    (with text in its cells) gives the layout + table-structure models a table
    region to detect. We render at a generous size so the synthetic glyphs are
    crisp enough for the recogniser to actually run rather than skip an empty page.
    """
    from PIL import Image, ImageDraw, ImageFont

    W, H = 1240, 1754  # ~150 DPI A4
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)

    # A default bitmap font is always available; we don't rely on system TTFs
    # being present in the slim base image.
    font = ImageFont.load_default()

    # Heading + a couple of body lines — plain text for the OCR recogniser.
    draw.text((80, 80), "PRIOR AUTHORIZATION POLICY", fill="black", font=font)
    draw.text((80, 120), "Plaque Psoriasis coverage criteria warmup page.", fill="black", font=font)
    draw.text((80, 150), "Step therapy and age requirements are listed below.", fill="black", font=font)

    # A simple 3-column x 3-row ruled grid with text in each cell so Docling
    # detects a table region and loads the table-structure model.
    x0, y0 = 80, 240
    col_w, row_h = 340, 70
    rows, cols = 3, 3
    cells = [
        ["Brand", "Step Therapy", "Age"],
        ["TREMFYA", "Required", "18+"],
        ["SKYRIZI", "Not required", "18+"],
    ]
    for r in range(rows + 1):  # horizontal rules
        y = y0 + r * row_h
        draw.line([(x0, y), (x0 + cols * col_w, y)], fill="black", width=2)
    for c in range(cols + 1):  # vertical rules
        x = x0 + c * col_w
        draw.line([(x, y0), (x, y0 + rows * row_h)], fill="black", width=2)
    for r in range(rows):  # cell text
        for c in range(cols):
            draw.text((x0 + c * col_w + 12, y0 + r * row_h + 24),
                      cells[r][c], fill="black", font=font)

    img.save(path, "PDF", resolution=150.0)


def main() -> int:
    tmp = Path(tempfile.gettempdir()) / "warmup.pdf"
    _render_warmup_pdf(tmp)

    # Import here (not at module top) so a failure rendering the page is reported
    # distinctly from a failure inside the heavy Docling stack.
    from pipeline import core

    doc, md = core._docling_convert(tmp.read_bytes(), "warmup.pdf")
    # Touch the outputs so a silently-empty conversion is visible in build logs;
    # this does not gate the build (the Dockerfile wraps us in `|| true`).
    has_tables = bool(getattr(doc, "tables", None))
    print(f"warmup_build: Docling + Surya layout/OCR/table models loaded and cached "
          f"(markdown_chars={len(md)}, tables_detected={has_tables})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — best-effort; never hard-fail the build.
        # Printed (not raised) so the `|| true` in the Dockerfile keeps the build
        # green while leaving a breadcrumb if the bake didn't complete.
        print(f"warmup_build: skipped (models will lazy-load at runtime): {e}",
              file=sys.stderr)
        sys.exit(0)
