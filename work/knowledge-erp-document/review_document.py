from __future__ import annotations

import json
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageDraw
from pypdf import PdfReader


WORK = Path(__file__).resolve().parent
OUT = WORK / "render"
OUT.mkdir(exist_ok=True)
pdf_path = WORK / "review.pdf"
doc = pdfium.PdfDocument(pdf_path)
reader = PdfReader(str(pdf_path))
pages = []
for i, page in enumerate(doc):
    bitmap = page.render(scale=2)
    image = bitmap.to_pil()
    image.save(OUT / f"page-{i + 1}.png")
    text = reader.pages[i].extract_text() or ""
    pages.append({"page": i + 1, "characters": len(text), "start": text[:110], "end": text[-100:]})

for batch in range(0, len(doc), 6):
    sheet = Image.new("RGB", (1224, 3 * 820), "#E5E5E5")
    draw = ImageDraw.Draw(sheet)
    for k in range(batch, min(batch + 6, len(doc))):
        image = Image.open(OUT / f"page-{k + 1}.png")
        image.thumbnail((592, 782))
        column, row = (k - batch) % 2, (k - batch) // 2
        x, y = column * 612 + 10, row * 820 + 25
        sheet.paste(image, (x, y))
        draw.text((x + 5, y - 18), f"PAGE {k+1}", fill="black")
    sheet.save(OUT / f"contact-{batch // 6 + 1}.png")

(WORK / "page_review.json").write_text(json.dumps(pages, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps([
    {"page": item["page"], "characters": item["characters"], "start": item["start"][:60], "end": item["end"][-55:]}
    for item in pages
], ensure_ascii=False, indent=2))
